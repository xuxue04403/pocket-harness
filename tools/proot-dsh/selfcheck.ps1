#Requires -Version 5.1
<#
.SYNOPSIS
    端到端自检：在设备上起 dsh web，用它的 token 换 cookie，确认首页真的返回 200 与标题。

.DESCRIPTION
    这是 tools/proot-dsh 的验收脚本。它做三件事：
      1. adb forward 到本机同号端口；
      2. 起 dsh web 并从 stdout 抓到带 token 的地址；
      3. 不带 token 请求应当是 401，带 token 请求应当拿到 303 + Set-Cookie，带 cookie 请求应当 200 且标题是 DeepSeek Harness。

    全程只打印状态码与标题，不打印 token —— 那个 token 等于这台设备上 dsh 的完全控制权。

.PARAMETER Port
    设备与主机的端口，默认 8123。

.PARAMETER Device
    adb 的设备序列号；只有一台设备时可省略。
#>
param(
    [int]$Port = 8123,
    [string]$Device = ''
)

$ErrorActionPreference = 'Stop'

function Get-AdbArgs {
    if ([string]::IsNullOrWhiteSpace($Device)) { return @() }
    return @('-s', $Device)
}

function Invoke-Adb {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    & adb @((Get-AdbArgs) + $Args)
    if ($LASTEXITCODE -ne 0) { throw "adb $($Args -join ' ') failed with exit code $LASTEXITCODE" }
}

function Invoke-AdbQuiet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { return (& adb @((Get-AdbArgs) + $Args) 2>&1 | Out-String).Trim() }
    finally { $ErrorActionPreference = $previous }
}

# Windows PowerShell 5.1 的 Invoke-WebRequest 没有 -SkipHttpErrorCheck，
# 而 401/303 正是这里要检查的东西，所以自己发请求、自己读状态码。
function Get-Http([string]$Url, $Session) {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 20000
    if ($null -ne $Session) { $request.CookieContainer = $Session }
    try {
        $response = $request.GetResponse()
    } catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if ($null -eq $response) { throw }
    }
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    $result = [pscustomobject]@{
        StatusCode = [int]$response.StatusCode
        Content    = $body
        Bytes      = $body.Length
    }
    $response.Close()
    return $result
}

function New-Jar {
    $jar = New-Object System.Net.CookieContainer
    return $jar
}
$failures = @()
function Check([string]$Label, [bool]$Ok, [string]$Detail) {
    if ($Ok) { Write-Host "ok    $Label ($Detail)" }
    else { Write-Host "FAIL  $Label ($Detail)"; $script:failures += $Label }
}

$installed = Invoke-AdbQuiet shell "[ -x /data/local/tmp/dsh-root/usr/bin/node ] && echo yes || echo no"
if ($installed -ne 'yes') { throw 'no rootfs on the device; run tools/proot-dsh/provision.ps1 first' }

Invoke-Adb forward "tcp:$Port" "tcp:$Port" | Out-Null
Write-Host "forwarded 127.0.0.1:$Port -> device :$Port"

$adbArgs = (Get-AdbArgs) + @('shell', "/data/local/tmp/proot -r /data/local/tmp/dsh-root -0 -w /root -b /proc -b /dev -b /sys -b /data/local/tmp/resolv.conf:/etc/resolv.conf /bin/sh -c 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export HOME=/root; cd /root; dsh web --no-open --host 127.0.0.1 --port $Port'")
$job = Start-Job -ScriptBlock { param($a) & adb @a 2>&1 } -ArgumentList (,$adbArgs)

try {
    $url = $null
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-Date) -lt $deadline -and $null -eq $url) {
        Start-Sleep -Milliseconds 500
        foreach ($line in (Receive-Job -Job $job -Keep)) {
            if ($line -match '(https?://\S+)') { $url = $Matches[1]; break }
        }
    }
    if ($null -eq $url) { throw 'dsh web did not print its URL within three minutes' }
    Check 'dsh web prints a token URL' ($url -match '\?token=[A-Za-z0-9_-]{20,}') 'token present'

    # 1. 没有 cookie 的首页必须被挡住
    $bare = Get-Http "http://127.0.0.1:$Port/" $null
    Check 'without a cookie the UI refuses' ($bare.StatusCode -eq 401) "status $($bare.StatusCode)"
    Check 'the refusal explains itself' ($bare.Content -match 'authentication required') 'body mentions authentication'

    # 2. 带 token 的请求换 cookie：必须手动跟随重定向，否则会看到第二次 401
    $jar = New-Jar
    $tokenResp = Get-Http $url $jar
    Check 'the token URL redirects once' ($tokenResp.StatusCode -eq 303) "status $($tokenResp.StatusCode)"
    $cookie = $jar.GetCookies("http://127.0.0.1:$Port/")
    Check 'it hands out a session cookie' ($cookie.Count -ge 1) "$($cookie.Count) cookie(s)"

    # 3. 带 cookie 的首页应当是完整 UI
    $page = Get-Http "http://127.0.0.1:$Port/" $jar
    Check 'the UI loads with the cookie' ($page.StatusCode -eq 200) "status $($page.StatusCode)"
    $title = if ($page.Content -match '<title>([^<]+)</title>') { $Matches[1] } else { '' }
    Check 'it is the real harness UI' ($title -eq 'DeepSeek Harness') "title '$title'"
    Check 'the page is not a stub' ($page.Bytes -gt 20000) "$($page.Bytes) bytes"
} finally {
    Stop-Job -Job $job -ErrorAction SilentlyContinue
    Remove-Job -Job $job -ErrorAction SilentlyContinue
    Invoke-AdbQuiet shell "pkill -f 'dsh web' 2>/dev/null; true" | Out-Null
    Invoke-AdbQuiet forward --remove "tcp:$Port" | Out-Null
}

if ($failures.Count -eq 0) {
    Write-Host ''
    Write-Host 'MOBILE DSH SELF CHECK PASSED'
    exit 0
}
Write-Host ''
Write-Host "FAILED: $($failures -join '; ')"
exit 1
