# 取回两个 ABI 的 proot，放进 app/android/app/src/main/jniLibs/<abi>/。
#
# 为什么不把二进制入库：proot 是 GPLv2。把它当普通文件提交进仓库，等于在仓库里
# 分发 GPL 二进制而没有任何源码要约，这比「让打包的人自己跑一下这个脚本」更麻烦。
#
# 为什么用 Termux 的包而不是 Alpine 的 proot-static：
#   Alpine 的静态版在应用进程里跑不起来。它是静态链接的，启动子进程时要把
#   loader 抽到 $PROOT_TMP_DIR 再 exec，而 Android 10 起应用数据目录里的文件
#   不能 exec，于是 proot 在真正开始跟踪之前就被 SIGSYS/EPERM 掐掉，退出码 159、
#   stderr 一个字都没有。Termux 版是动态链接的，loader 单独一个文件，可以跟
#   proot 一起放进 nativeLibraryDir —— 那里是唯一允许 exec 的位置。
#
# 用法：pwsh -File tools/proot-fetch.ps1 [-Force]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cache = Join-Path $root 'probe\proot\termux'
New-Item -ItemType Directory -Force -Path $cache | Out-Null

$prootVersion = '5.1.107.102'
$tallocVersion = '2.5.0'
$shmemVersion = '0.7'

# 设备上的 ABI 名字 → Termux 的架构名字。
$targets = @(
    @{ Abi = 'arm64-v8a'; Arch = 'aarch64' },
    @{ Abi = 'x86_64'; Arch = 'x86_64' }
)

# 一个 deb 里要拿出来哪些成员，以及落到 jniLibs 里的名字。
# jniLibs 只收 lib*.so —— 别的名字 AGP 根本不会装进 APK。
$wanted = @(
    @{ Prefix = "proot_${prootVersion}"; Member = './data/data/com.termux/files/usr/bin/proot'; Out = 'libproot.so' },
    @{ Prefix = "proot_${prootVersion}"; Member = './data/data/com.termux/files/usr/libexec/proot/loader'; Out = 'libproot-loader.so' },
    @{ Prefix = "libtalloc_${tallocVersion}"; Member = './data/data/com.termux/files/usr/lib/libtalloc.so.2.5.0'; Out = 'libtalloc.so' },
    @{ Prefix = "libandroid-shmem_${shmemVersion}"; Member = './data/data/com.termux/files/usr/lib/libandroid-shmem.so'; Out = 'libandroid-shmem.so' }
)

function Get-Deb([string]$Arch, [string]$Prefix, [string]$Package) {
    $deb = Join-Path $cache "$($Prefix)_$Arch.deb"
    if (Test-Path $deb) { return $deb }
    $urls = @(
        "https://packages.termux.dev/apt/termux-main/pool/main/$Package/${Prefix}_$Arch.deb",
        "https://mirrors.tuna.tsinghua.edu.cn/termux/apt/termux-main/pool/main/$Package/${Prefix}_$Arch.deb"
    )
    foreach ($url in $urls) {
        try {
            Write-Host "fetch $url"
            Invoke-WebRequest -Uri $url -OutFile $deb -UseBasicParsing -TimeoutSec 180
            return $deb
        } catch {
            Write-Host "  miss: $($_.Exception.Message)"
            Remove-Item -Force $deb -ErrorAction SilentlyContinue
        }
    }
    throw "两个镜像都没拿到 ${Prefix}_$Arch.deb"
}

function Expand-Member([string]$Deb, [string]$Member, [string]$Into) {
    $dir = Join-Path $cache 'unpack'
    Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    # .deb 是 ar 归档；Windows 自带的 bsdtar 认得它，也认得里面的 data.tar.xz。
    & tar.exe -xf $Deb -C $dir
    if (-not (Test-Path (Join-Path $dir 'data.tar.xz'))) {
        throw "不是预期的 .deb 结构：$Deb"
    }
    # 只挑那一个成员：data.tar.xz 里有带尾随空格的路径，整包解会报 Invalid argument。
    & tar.exe -xf (Join-Path $dir 'data.tar.xz') -C $dir $Member
    $name = Split-Path -Leaf $Member
    $file = Join-Path $dir "$Member"
    if (-not (Test-Path $file)) { throw "deb 里没有 $Member（$Deb）" }
    Copy-Item $file $Into -Force
}

foreach ($target in $targets) {
    $abi = $target.Abi
    $arch = $target.Arch
    $outDir = Join-Path $root "app\android\app\src\main\jniLibs\$abi"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $debs = @{
        "proot_${prootVersion}" = Get-Deb -Arch $arch -Prefix "proot_$prootVersion" -Package 'p/proot'
        "libtalloc_${tallocVersion}" = Get-Deb -Arch $arch -Prefix "libtalloc_$tallocVersion" -Package 'libt/libtalloc'
        "libandroid-shmem_${shmemVersion}" = Get-Deb -Arch $arch -Prefix "libandroid-shmem_$shmemVersion" -Package 'liba/libandroid-shmem'
    }

    foreach ($item in $wanted) {
        $out = Join-Path $outDir $item.Out
        if ((Test-Path $out) -and (-not $Force)) {
            Write-Host "have  $abi  $($item.Out)  $((Get-Item $out).Length) bytes"
            continue
        }
        Expand-Member -Deb $debs[$item.Prefix] -Member $item.Member -Into $out
        $hash = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
        Write-Host "wrote $abi  $($item.Out)  $((Get-Item $out).Length) bytes  sha256=$hash"
    }
}

Write-Host ''
Write-Host 'jniLibs 已就位。它们只在 --target-platform android-x64 / android-arm64 时进包。'
Write-Host '注意：libtalloc.so 会由 MainActivity 在运行时复制成 libtalloc.so.2（proot 的 DT_NEEDED 写的是带版本号的名字）。'
