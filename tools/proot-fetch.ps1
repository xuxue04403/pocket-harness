# 取回两个 ABI 的静态 proot，放进 app/android/app/src/main/jniLibs/<abi>/libproot.so。
#
# 为什么不把二进制入库：proot 是 GPLv2。把它当普通文件提交进仓库，等于在仓库里
# 分发 GPL 二进制而没有任何源码要约，这比「让打包的人自己跑一下这个脚本」更麻烦。
# 脚本取的是 Alpine 官方 APK 里的 proot.static，纯静态、不依赖 bionic、体积小。
#
# 用法：pwsh -File tools/proot-fetch.ps1
param(
    [string]$Version = '5.4.0-r2',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cache = Join-Path $root 'probe\proot\apk'
New-Item -ItemType Directory -Force -Path $cache | Out-Null

# 设备上的 ABI 名字 → Alpine 的架构名字。
$targets = @(
    @{ Abi = 'arm64-v8a'; Alpine = 'aarch64' },
    @{ Abi = 'x86_64'; Alpine = 'x86_64' }
)

foreach ($target in $targets) {
    $abi = $target.Abi
    $alpine = $target.Alpine
    $apk = Join-Path $cache "proot-static-$alpine-$Version.apk"
    $extract = Join-Path $cache "extract-$alpine-$Version"
    $binary = Join-Path $extract 'usr\bin\proot.static'
    $outDir = Join-Path $root "app\android\app\src\main\jniLibs\$abi"
    $out = Join-Path $outDir 'libproot.so'

    if ((Test-Path $out) -and (-not $Force)) {
        Write-Host "have  $abi  $out"
        continue
    }

    if (-not (Test-Path $binary)) {
        if (-not (Test-Path $apk)) {
            # dl-cdn 在国内容易断（`Received an unexpected EOF`），所以有备选镜像。
            $mirrors = @(
                "https://dl-cdn.alpinelinux.org/alpine/edge/community/$alpine/proot-static-$Version.apk",
                "https://mirrors.tuna.tsinghua.edu.cn/alpine/edge/community/$alpine/proot-static-$Version.apk",
                "https://mirrors.aliyun.com/alpine/edge/community/$alpine/proot-static-$Version.apk"
            )
            $fetched = $false
            foreach ($url in $mirrors) {
                try {
                    Write-Host "fetch $url"
                    Invoke-WebRequest -Uri $url -OutFile $apk -UseBasicParsing -TimeoutSec 120
                    $fetched = $true
                    break
                } catch {
                    Write-Host "  miss: $($_.Exception.Message)"
                    Remove-Item -Force $apk -ErrorAction SilentlyContinue
                }
            }
            if (-not $fetched) {
                throw "三个镜像都没拿到 proot-static-$Version（$alpine）"
            }
        }
        Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Force -Path $extract | Out-Null
        # Alpine 的 .apk 其实是 gzip 压缩的 tar，直接用系统 tar 就能解。
        & tar.exe -xzf $apk -C $extract
        if (-not (Test-Path $binary)) {
            throw "apk 里没有 usr/bin/proot.static：$apk"
        }
    }

    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    Copy-Item $binary $out -Force
    $hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
    Write-Host "wrote $abi  $((Get-Item $out).Length) bytes  sha256=$hash"
}

Write-Host ''
Write-Host 'libproot.so 已就位。它们只在 --target-platform android-x64 / android-arm64 时进包。'
