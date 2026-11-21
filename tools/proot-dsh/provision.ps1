#Requires -Version 5.1
<#
.SYNOPSIS
    在一台 Android 设备上装好「本机跑 dsh」所需的一切：静态 proot、Alpine rootfs、Node 24、@deepseek-ai/dsh。

.DESCRIPTION
    只用 adb，不需要 root、不需要 Termux。设备上落到 /data/local/tmp/dsh-root（约 2.0 GB），
    所以要确认设备有空间。重复执行是幂等的：已经装好的步骤会跳过。

.PARAMETER Device
    adb 的设备序列号；只有一台设备时可省略。

.PARAMETER DshVersion
    要装的 dsh 版本，默认 0.2.2-rc.5（与桌面端一致）。

.PARAMETER Force
    丢弃已有 rootfs 重新装。
#>
param(
    [string]$Device = '',
    [string]$DshVersion = '0.2.2-rc.5',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$Root = '/data/local/tmp'
$Rootfs = "$Root/dsh-root"
$ProotBin = "$Root/proot"
$TarGz = "$Root/alpine.tar.gz"
$Resolv = "$Root/resolv.conf"

$Cache = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force -Path $Cache | Out-Null

$AlpineUrl = 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.0-x86_64.tar.gz'
$ProotUrl = 'https://github.com/proot-me/proot/releases/download/v5.5.0/proot'
# GitHub releases 的直链在本机不通时，走这个代理同样的字节
$ProotMirror = 'https://gh-proxy.com/https://github.com/proot-me/proot/releases/download/v5.5.0/proot'

function Get-AdbArgs {
    if ([string]::IsNullOrWhiteSpace($Device)) { return @() }
    return @('-s', $Device)
}

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $all = (Get-AdbArgs) + $Args
    & adb @all
    if ($LASTEXITCODE -ne 0) { throw "adb $($Args -join ' ') failed with exit code $LASTEXITCODE" }
}

function Invoke-AdbQuiet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $all = (Get-AdbArgs) + $Args
    # 有些 adb shell 命令本来就会往 stderr 写东西（toybox 的 pkill 之类），这里不该当成致命错误
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        return (& adb @all 2>&1 | Out-String).Trim()
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Get-Cached([string]$Path, [string]$Url, [string]$Mirror) {
    if (Test-Path $Path) {
        Write-Host "cache hit  $(Split-Path -Leaf $Path)"
        return
    }
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Path -TimeoutSec 600
    } catch {
        if ([string]::IsNullOrWhiteSpace($Mirror)) { throw }
        Write-Host "direct download failed, trying the mirror"
        Invoke-WebRequest -Uri $Mirror -OutFile $Path -TimeoutSec 600
    }
}

function Assert-Device {
    $state = Invoke-AdbQuiet shell "getprop ro.build.version.sdk"
    if ($state -notmatch '^\d+$') { throw 'no usable Android device; check `adb devices`' }
    $abi = Invoke-AdbQuiet shell "getprop ro.product.cpu.abi"
    Write-Host "device api $state, abi $abi"
    if ($abi -notmatch 'x86_64|arm64') {
        throw "unsupported abi $abi; the prebuilt proot here is x86_64 (arm64 needs the matching proot build)"
    }
    if ($abi -ne 'x86_64') {
        throw "this script ships an x86_64 rootfs; build a $abi rootfs first (see docs/mobile-local-dsh.md)"
    }
    # toybox 的 df 没有 -m，只能读 1K 块；Use% 前面那一列才是 Available
    $free = Invoke-AdbQuiet shell "df $Root"
    $line = ($free -split "`n" | Select-Object -Last 1)
    if ($line -match '(\d+)\s+(\d+)%\s') {
        $freeMb = [int]([int64]$Matches[1] / 1024)
        Write-Host "free space under $Root : $freeMb MB"
        if ($freeMb -lt 2600) { throw "need about 2.6 GB free under $Root, found ${freeMb} MB" }
    }
}

function Remove-Rootfs {
    Write-Host "removing $Rootfs"
    Invoke-AdbQuiet shell "pkill -f 'dsh web' 2>/dev/null; rm -rf $Rootfs" | Out-Null
}

Write-Host '== checking the device'
Assert-Device

Write-Host '== fetching artifacts'
$prootLocal = Join-Path $Cache 'proot'
$alpineLocal = Join-Path $Cache 'alpine-minirootfs.tar.gz'
Get-Cached $prootLocal $ProotUrl $ProotMirror
Get-Cached $alpineLocal $AlpineUrl $null

Write-Host '== pushing proot and the rootfs'
Invoke-Adb push $prootLocal $ProotBin | Out-Null
Invoke-Adb shell "chmod 755 $ProotBin"

if ($Force) { Remove-Rootfs }

$installed = Invoke-AdbQuiet shell "[ -x $Rootfs/usr/bin/node ] && echo yes || echo no"
if ($installed -eq 'yes') {
    Write-Host 'rootfs already has node; skipping the extract and install'
} else {
    Invoke-Adb push $alpineLocal $TarGz | Out-Null
    Invoke-Adb shell "rm -rf $Rootfs; mkdir -p $Rootfs; tar -xzf $TarGz -C $Rootfs"

    # Android 没有 /etc/resolv.conf，不 bind 进去 apk 什么都下载不了
    $resolvLocal = Join-Path $Cache 'resolv.conf'
    if (-not (Test-Path $resolvLocal)) {
        "nameserver 223.5.5.5`nnameserver 8.8.8.8`n" | Set-Content -Encoding ascii $resolvLocal
    }
    Invoke-Adb push $resolvLocal $Resolv | Out-Null

    Write-Host '== installing node 24 and dsh inside the rootfs (a few minutes)'
    # edge 的 nodejs 需要 edge 的 openssl，两个必须一起装，否则 node 起不来（OSSL_* symbol not found）
    $inner = @(
        'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        'export HOME=/root'
        'set -e'
        "apk add --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/edge/main nodejs npm"
        "apk add --no-cache --repository https://dl-cdn.alpinelinux.org/alpine/edge/main --upgrade libssl3 libcrypto3"
        'npm config set registry https://registry.npmmirror.com'
        "npm install -g @deepseek-ai/dsh@$DshVersion"
        'node --version'
        'dsh --version'
    ) -join ' && '
    $proot = "$ProotBin -r $Rootfs -0 -w /root -b /proc -b /dev -b /sys -b ${Resolv}:/etc/resolv.conf"
    Invoke-Adb shell "$proot /bin/sh -c '$inner'"
}

Write-Host ''
Write-Host '== done'
$version = Invoke-AdbQuiet shell "$ProotBin -r $Rootfs -0 -w /root -b /proc -b /dev -b /sys /usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin HOME=/root /bin/sh -c 'dsh --version'"
Write-Host "dsh inside the rootfs: $version"
Write-Host 'start it with: tools/proot-dsh/run.ps1'
