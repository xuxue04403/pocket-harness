#Requires -Version 5.1
<#
.SYNOPSIS
    在 Android 设备上把 dsh 的 Web UI 跑起来，并把带 token 的地址打印出来。

.DESCRIPTION
    前台启动 dsh web（需要一个装着 dsh 的 PRoot rootfs，见 provision.ps1）。
    同时用 `adb forward` 把设备端口映射到本机，于是本机的浏览器也能打开那个地址 ——
    这一步只是为了验证，App 里用不到。

    这个脚本会在前台一直跑，Ctrl+C 结束时顺手把设备上的 dsh 收掉。

.PARAMETER Port
    设备上监听的端口，默认 8123。

.PARAMETER Forward
    传了这个开关就用 adb forward 把端口映射到本机同号端口。

.PARAMETER Device
    adb 的设备序列号；只有一台设备时可省略。
#>
param(
    [int]$Port = 8123,
    [switch]$Forward,
    [string]$Device = ''
)

$ErrorActionPreference = 'Stop'

$Root = '/data/local/tmp'
$Rootfs = "$Root/dsh-root"
$ProotBin = "$Root/proot"
$Resolv = "$Root/resolv.conf"

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

$installed = (& adb @((Get-AdbArgs) + @('shell', "[ -x $Rootfs/usr/bin/node ] && echo yes || echo no")) 2>&1 | Out-String).Trim()
if ($installed -ne 'yes') {
    throw "no rootfs at $Rootfs; run tools/proot-dsh/provision.ps1 first"
}

if ($Forward) {
    Invoke-Adb forward "tcp:$Port" "tcp:$Port" | Out-Null
    Write-Host "forwarded 127.0.0.1:$Port -> device :$Port"
}

# dsh web 会把带 token 的地址打进 stdout；我们把它抓出来显示给用户
$proot = "$ProotBin -r $Rootfs -0 -w /root -b /proc -b /dev -b /sys -b ${Resolv}:/etc/resolv.conf"
$command = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export HOME=/root; cd /root; dsh web --no-open --host 127.0.0.1 --port $Port"

$adbArgs = (Get-AdbArgs) + @('shell', "$proot /bin/sh -c '$command'")
Write-Host "starting dsh web on the device (port $Port)…"

$job = Start-Job -ScriptBlock {
    param($adbArgs)
    & adb @adbArgs 2>&1
} -ArgumentList (,$adbArgs)

try {
    $url = $null
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline -and $null -eq $url) {
        Start-Sleep -Milliseconds 500
        $lines = Receive-Job -Job $job -Keep
        foreach ($line in $lines) {
            if ($line -match '(https?://\S+)') { $url = $Matches[1]; break }
        }
    }
    if ($null -eq $url) {
        throw 'dsh web did not print its URL within three minutes; check `adb logcat` and the rootfs'
    }
    Write-Host ''
    Write-Host "dsh web is up: $url"
    if ($Forward) {
        $hostUrl = $url -replace '127\.0\.0\.1', '127.0.0.1'
        Write-Host "open on this machine: $hostUrl"
    }
    Write-Host ''
    Write-Host 'Ctrl+C to stop.'
    while ($true) {
        Start-Sleep -Seconds 2
        $state = (Get-Job -Id $job.Id).State
        if ($state -ne 'Running') {
            Write-Host 'dsh web exited on the device:'
            Receive-Job -Job $job
            break
        }
    }
} finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -ErrorAction SilentlyContinue
    & adb @((Get-AdbArgs) + @('shell', "pkill -f 'dsh web' 2>/dev/null; true")) | Out-Null
    if ($Forward) {
        & adb @((Get-AdbArgs) + @('forward', '--remove', "tcp:$Port")) | Out-Null
    }
    Write-Host 'stopped.'
}
