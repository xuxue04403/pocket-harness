# 在 Windows 上真编译 ArkTS 宿主（不产出 Dart AOT）。
# 用法：.\build.ps1 [-Sdk <SDK 根目录>]
# 不给 -Sdk 时依次看 OHOS_BASE_SDK_HOME、DEVECO_SDK_HOME，最后才是本机默认路径，
# 这样 CI 上只要把 SDK 摆好并设这两个环境变量之一就能直接跑。
param(
  [string]$Sdk = ''
)

if (-not $Sdk) {
  if ($env:OHOS_BASE_SDK_HOME) { $Sdk = $env:OHOS_BASE_SDK_HOME }
  elseif ($env:DEVECO_SDK_HOME) { $Sdk = $env:DEVECO_SDK_HOME }
  else { $Sdk = 'D:\IDE\dsh-bot\toolchain\ohos\sdk' }
}

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  if (-not (Test-Path "$Sdk\26.0.0\ets\oh-uni-package.json")) {
    throw "SDK 布局不对：需要 <根>\26.0.0\{ets,js,native,toolchains,previewer}，当前 $Sdk"
  }
  if (-not (Test-Path 'node_modules\@ohos\hvigor\bin\hvigor.js')) {
    throw '缺少 hvigor：先跑 npm install --registry=https://repo.harmonyos.com/npm @ohos/hvigor@6.26.20 @ohos/hvigor-ohos-plugin@6.26.20'
  }

  # hvigor 只认这两个环境变量之一，设两个最稳。
  $env:DEVECO_SDK_HOME = $Sdk
  $env:OHOS_BASE_SDK_HOME = $Sdk

  # 协议核心只有一份：从 packages/dsh_arkts 拷进来，避免这里躺着一份会漂移的副本。
  # 两个坑：目标目录必须先建好（否则 Copy-Item 会把文件铺到当前工作目录），
  # 并且通配符要交给 Copy-Item 自己展开（用 -LiteralPath 过滤再管道时曾把目标写错）。
  # 子目录（src/qr）要单独拷：`src/*.ts` 不会递归，漏了 qr 就会在 hvigor 里报找不到模块。
  $core = Join-Path $root 'entry\src\main\ets\core'
  $pattern = Join-Path $root '..\..\packages\dsh_arkts\src\*.ts'
  if (Test-Path $pattern) {
    New-Item -ItemType Directory -Force -Path $core | Out-Null
    Copy-Item -Path $pattern -Destination $core -Force
    $qrSource = Join-Path $root '..\..\packages\dsh_arkts\src\qr'
    if (Test-Path $qrSource) {
      $qrTarget = Join-Path $core 'qr'
      New-Item -ItemType Directory -Force -Path $qrTarget | Out-Null
      Copy-Item -Path (Join-Path $qrSource '*.ts') -Destination $qrTarget -Force
    }
    $copied = (Get-ChildItem -Path $core -Filter '*.ts' -File).Count
    $copiedQr = (Get-ChildItem -Path $core\qr -Filter '*.ts' -File -ErrorAction SilentlyContinue).Count
    Write-Host "synced $copied protocol files and $copiedQr qr files into $core"
  }

  node node_modules\@ohos\hvigor\bin\hvigor.js --mode module -p product=default assembleHap --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "hvigor 退出码 $LASTEXITCODE" }

  Get-ChildItem -Recurse -Filter *.hap entry\build |
    Select-Object FullName, Length

  # hvigor 只产出未签名的 HAP，装不上真机也不进 sideload 流程。
  # 签名交给 tools/ohos-sign.ps1（用 SDK 自带的 OpenHarmony.p12，不需要华为账号）；
  # 这里只负责调用，签名失败就让整个构建失败 —— 免得拿着未签名的包去装。
  $unsigned = Get-ChildItem -Recurse -Filter 'entry-default-unsigned.hap' entry\build |
    Select-Object -First 1
  if ($unsigned) {
    $signScript = Join-Path $root '..\ohos-sign.ps1'
    if (-not (Test-Path $signScript)) { throw "找不到签名脚本：$signScript" }
    & $signScript -Hap $unsigned.FullName -BundleName 'cn.pocketharness.probe' -SdkRoot (Join-Path $Sdk '26.0.0')
    if ($LASTEXITCODE -ne 0) { throw "签名失败，退出码 $LASTEXITCODE" }
  }
}
finally {
  Pop-Location
}
