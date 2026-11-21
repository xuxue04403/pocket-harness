# 在 Windows 上真编译 ArkTS 宿主（不产出 Dart AOT）。
# 用法：.\build.ps1 [-Sdk <SDK 根目录>]
param(
  [string]$Sdk = 'D:\IDE\dsh-bot\toolchain\ohos\sdk'
)

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
  $core = Join-Path $root 'entry\src\main\ets\core'
  $pattern = Join-Path $root '..\..\packages\dsh_arkts\src\*.ts'
  if (Test-Path $pattern) {
    New-Item -ItemType Directory -Force -Path $core | Out-Null
    Copy-Item -Path $pattern -Destination $core -Force
    $copied = (Get-ChildItem -Path $core -Filter '*.ts' -File).Count
    Write-Host "synced $copied protocol files into $core"
  }

  node node_modules\@ohos\hvigor\bin\hvigor.js --mode module -p product=default assembleHap --no-daemon
  if ($LASTEXITCODE -ne 0) { throw "hvigor 退出码 $LASTEXITCODE" }

  Get-ChildItem -Recurse -Filter *.hap entry\build |
    Select-Object FullName, Length
}
finally {
  Pop-Location
}
