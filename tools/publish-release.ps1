# 把 v0.1.0-beta 推到 GitHub 并建 release。
#
# 用法：先把 PAT 写进 probe/_gh_token.txt（一行，不要引号；这个路径在 .gitignore 里），
# 然后 & tools\publish-release.ps1 -Owner <你的账号> [-Repo pocket-harness] [-Tag v0.1.0-beta]
#
# 注意：PowerShell 5.1 读无 BOM 的 .ps1 会按 GBK 解码、把中文注释后面的代码一并吞掉，
# 所以这个文件必须存成带 BOM 的 UTF-8。

param(
    [Parameter(Mandatory = $true)][string] $Owner,
    [string] $Repo = 'pocket-harness',
    [string] $Tag = 'v0.1.0-beta',
    [string] $TokenFile = (Join-Path $PSScriptRoot '..\probe\_gh_token.txt'),
    [switch] $SkipRelease
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Fail([string] $message) {
    Write-Host "失败：$message"
    exit 1
}

if (-not (Test-Path $TokenFile)) { Fail "找不到 $TokenFile。请先把 PAT 写进去（一行，不要引号）。" }
$token = (Get-Content $TokenFile -Raw).Trim()
if ($token.Length -lt 20) { Fail 'token 太短，看起来没写对。' }

$headers = @{
    Authorization          = "Bearer $token"
    'User-Agent'           = 'pocket-harness'
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
}

# 1. 仓库：存在就复用，不存在就建。
$full = "$Owner/$Repo"
try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$full" -Headers $headers -Method Get
    Write-Host "仓库已存在：$full"
} catch {
    Write-Host "创建仓库 $full ..."
    $body = @{
        name        = $Repo
        description = '用手机远程操控电脑上的 DeepSeek Harness'
        private     = $false
        has_issues  = $true
        has_wiki    = $false
    } | ConvertTo-Json -Compress
    try {
        $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
        Write-Host "已创建：$($repo.full_name)"
    } catch {
        Fail "建仓库失败：$($_.Exception.Message) $($_.ErrorDetails.Message)"
    }
}

# 2. remote + push（用 token 走 HTTPS，不写进 .git/config 的 url）。
$push = "https://x-access-token:$token@github.com/$full.git"
Push-Location $root
try {
    $existing = git remote 2>$null
    if ($existing -contains 'origin') { git remote remove origin }
    git remote add origin "https://github.com/$full.git"
    git push $push 'refs/heads/master:refs/heads/main' --force
    if ($LASTEXITCODE -ne 0) { Fail "push master 失败（退出码 $LASTEXITCODE）。" }
    git push $push "refs/tags/${Tag}" --force
    if ($LASTEXITCODE -ne 0) { Fail "push tag 失败（退出码 $LASTEXITCODE）。" }
    Write-Host "已推送 master 与 $Tag"
} finally {
    Pop-Location
}

if ($SkipRelease) { Write-Host '按 -SkipRelease 跳过 release。'; exit 0 }

# 3. release + 三个 APK。
$dist = Join-Path $root "dist\$Tag"
$notes = Join-Path $dist 'RELEASE_NOTES.md'
if (-not (Test-Path $notes)) { Fail "找不到 $notes。" }

try {
    $null = Invoke-RestMethod -Uri "https://api.github.com/repos/$full/releases/tags/$Tag" -Headers $headers -Method Get
    Write-Host "release $Tag 已存在，只补传缺失的附件。"
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$full/releases/tags/$Tag" -Headers $headers -Method Get
} catch {
    $body = @{
        tag_name         = $Tag
        target_commitish = 'main'
        name             = "Pocket Harness $Tag"
        body             = (Get-Content $notes -Raw)
        draft            = $false
        prerelease       = $true
    } | ConvertTo-Json -Compress
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$full/releases" -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    Write-Host "已建 release：$($release.html_url)"
}

$uploadBase = ($release.upload_url -replace '\{.*$', '')
foreach ($asset in @('pocket-harness-0.1.0-beta-arm64-v8a.apk', 'pocket-harness-0.1.0-beta-armeabi-v7a.apk', 'pocket-harness-0.1.0-beta-x86_64.apk', 'SHA256SUMS.txt')) {
    $path = Join-Path $dist $asset
    if (-not (Test-Path $path)) { Write-Host "跳过缺失的 $asset"; continue }
    $bytes = [IO.File]::ReadAllBytes($path)
    $type = if ($asset -like '*.apk') { 'application/vnd.android.package-archive' } else { 'text/plain' }
    $url = "$uploadBase`?name=$asset"
    try {
        $null = Invoke-RestMethod -Uri $url -Headers $headers -Method Post -ContentType $type -Body $bytes
        Write-Host "已上传 $asset（$([Math]::Round($bytes.Length / 1MB, 1)) MB）"
    } catch {
        Write-Host "上传 $asset 失败：$($_.Exception.Message) $($_.ErrorDetails.Message)"
    }
}

Write-Host ''
Write-Host "发布页：$($release.html_url)"
