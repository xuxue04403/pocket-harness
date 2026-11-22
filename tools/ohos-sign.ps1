#Requires -Version 5.1
<#
.SYNOPSIS
    用 OpenHarmony SDK 自带的 hap-sign-tool 给探针 HAP 签名。

.DESCRIPTION
    SDK 的 toolchains/lib 下已经带了一套可用的签名材料：OpenHarmony.p12
    （口令 123456）、OpenHarmonyProfileRelease.pem（三级证书链）、
    UnsgnedReleasedProfileTemplate.json。这个脚本把它们拼起来给 HAP 签名，
    不需要登录华为账号，也不需要 DevEco Studio。

    三个参数必须对上，否则报错信息会把人带偏：
      -appCertFile  必须是「叶子证书 + Application CA + Root CA」三级链
      -profileFile  必须是 sign-profile 签过的 .p7b
      -keystoreFile 用的是原版 OpenHarmony.p12，不要自己重签证书

    踩过的坑（写在这里免得下次再试）：
      1. 手工从 p12 导证书拼链，sign-app 会报
         `verify certificate chain failed! Signature does not match.`
         因为 p12 里 `openharmony application release` 的证书链长度是 1（自签），
         而 profile 模板里那张叶子证书的 issuer 是 Application CA。两者不是同一张。
      2. 手写 profile 的 `distribution-certificate` 字段只要不是模板原文，
         sign-app 就报 `Illegal base64 character 20` —— 这条报错跟 base64 无关，
         它掩盖的是「profile 里的证书和 -appCertFile 的叶子证书对不上」。
      3. 所以正确做法是：直接用模板里的那张叶子证书 + SDK 的 CA/root 拼成链，
         并对模板原文只做字段替换（bundle-name / developer-id / 版本号 / 有效期 / uuid），
         绝不动 `distribution-certificate` 的值。

.PARAMETER Hap
    待签名的 HAP（hvigor 产物 entry-default-unsigned.hap）。

.PARAMETER OutFile
    输出路径，默认与输入同目录，文件名把 -unsigned 换成 -signed。

.PARAMETER BundleName
    要写进 profile 的 bundle-name，必须与 HAP 内 module.json 的 bundleName 一致。

.PARAMETER CompatibleVersion
    API 兼容版本，默认 8。

.EXAMPLE
    .\ohos-sign.ps1 -Hap ..\tools\ohos-probe\entry\build\default\outputs\default\entry-default-unsigned.hap -BundleName cn.pocketharness.probe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Hap,
    [string]$OutFile,
    [string]$BundleName = 'cn.pocketharness.probe',
    [int]$CompatibleVersion = 8,
    [string]$SdkRoot = 'D:\IDE\dsh-bot\toolchain\ohos\sdk\26.0.0'
)

$ErrorActionPreference = 'Stop'

$lib = Join-Path $SdkRoot 'toolchains\lib'
$signTool = Join-Path $lib 'hap-sign-tool.jar'
$keystore = Join-Path $lib 'OpenHarmony.p12'
$profilePem = Join-Path $lib 'OpenHarmonyProfileRelease.pem'
$template = Join-Path $lib 'UnsgnedReleasedProfileTemplate.json'
$storePass = '123456'

foreach ($path in @($Hap, $signTool, $keystore, $profilePem, $template)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "缺少文件：$path" }
}

$java = Join-Path $env:JAVA_HOME 'bin\java.exe'
if (-not (Test-Path -LiteralPath $java)) {
    $java = (Get-Command java.exe -ErrorAction SilentlyContinue).Source
}
if (-not $java) { throw '找不到 java.exe，请设置 JAVA_HOME' }

if (-not $OutFile) {
    $dir = Split-Path -Parent $Hap
    $leafName = (Split-Path -Leaf $Hap) -replace '-unsigned', '-signed'
    $OutFile = Join-Path $dir $leafName
}

$work = Join-Path (Split-Path -Parent $OutFile) '_sign'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 1. 从模板里取出叶子证书，拼上 SDK 的 CA 与 Root CA 组成三级链。
#    这三张证书是配套的，混用别的证书链会让 sign-app 报签名不匹配。
function Export-Alias {
    param([string]$Alias, [string]$Target)
    $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
    if (-not (Test-Path -LiteralPath $keytool)) { throw '找不到 keytool.exe' }
    $pem = & $keytool -exportcert -rfc -alias $Alias -keystore $keystore -storetype PKCS12 -storepass $storePass 2>$null
    if (-not $pem) { throw "从 keystore 导出 $Alias 失败" }
    [IO.File]::WriteAllText($Target, (($pem -join "`n") + "`n"), $utf8)
    return $Target
}

$templateText = [IO.File]::ReadAllText($template)
$match = [regex]::Match($templateText, '"distribution-certificate":\s*"((?:[^"\\]|\\.)*)"')
if (-not $match.Success) { throw '模板里找不到 distribution-certificate 字段' }
$templateLeaf = $match.Groups[1].Value -replace '\\n', "`n"
$leafPath = Join-Path $work 'app-leaf.cer'
[IO.File]::WriteAllText($leafPath, $templateLeaf, $utf8)

$caPath = Export-Alias -Alias 'openharmony application ca' -Target (Join-Path $work 'app-ca.cer')
$rootPath = Export-Alias -Alias 'openharmony application root ca' -Target (Join-Path $work 'app-root.cer')

$chainPath = Join-Path $work 'app-cert-chain.cer'
$chain = [IO.File]::ReadAllText($leafPath).TrimEnd() + "`n" +
         [IO.File]::ReadAllText($caPath).TrimEnd() + "`n" +
         [IO.File]::ReadAllText($rootPath).TrimEnd() + "`n"
[IO.File]::WriteAllText($chainPath, $chain, $utf8)

# 2. profile 只替换字段值，distribution-certificate 保持模板原文。
$now = [int64]((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds
$after = $now + [int64](3600 * 24 * 3650)
$uuid = [guid]::NewGuid().ToString()

$profileText = $templateText
$profileText = $profileText -replace '"bundle-name":\s*"[^"]*"', "`"bundle-name`": `"$BundleName`""
$profileText = $profileText -replace '"developer-id":\s*"[^"]*"', '"developer-id": "pocketharness"'
$profileText = $profileText -replace '"not-before":\s*\d+', "`"not-before`": $now"
$profileText = $profileText -replace '"not-after":\s*\d+', "`"not-after`": $after"
$profileText = $profileText -replace '"uuid":\s*"[^"]*"', "`"uuid`": `"$uuid`""

$profileJson = Join-Path $work 'profile.json'
[IO.File]::WriteAllText($profileJson, $profileText, $utf8)

$profileP7b = Join-Path $work 'profile.p7b'
& $java -jar $signTool sign-profile -mode localSign `
    -keyAlias 'openharmony application profile release' -keyPwd $storePass `
    -profileCertFile $profilePem -inFile $profileJson -signAlg SHA256withECDSA `
    -keystoreFile $keystore -keystorePwd $storePass -outFile $profileP7b | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $profileP7b)) {
    throw 'sign-profile 失败'
}
Write-Host "profile 已签名：$profileP7b"

# 3. 给 HAP 签名。
& $java -jar $signTool sign-app -mode localSign `
    -keyAlias 'openharmony application release' -keyPwd $storePass `
    -appCertFile $chainPath -profileFile $profileP7b -inFile $Hap `
    -signAlg SHA256withECDSA -keystoreFile $keystore -keystorePwd $storePass `
    -outFile $OutFile -compatibleVersion $CompatibleVersion | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutFile)) {
    throw 'sign-app 失败'
}

# 4. 回验一次，别把签坏的东西交出去。
$outChain = Join-Path $work 'verify-chain.cer'
$outProfile = Join-Path $work 'verify-profile.p7b'
$verify = & $java -jar $signTool verify-app -inFile $OutFile -outCertChain $outChain -outProfile $outProfile 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "verify-app 失败：$($verify -join ' ')"
}

$size = (Get-Item -LiteralPath $OutFile).Length
Write-Host "已签名并校验通过：$OutFile（$size 字节）"
