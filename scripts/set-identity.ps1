# Sets the Microsoft Store identity values in package.json.
#
# Get these three values from Partner Center:
#   Apps and games -> your app -> Product identity
#     - Package/Identity/Name          -> -IdentityName   (e.g. 12345PublisherName.NotesApp)
#     - Package/Properties/Publisher   -> -Publisher      (e.g. CN=1A2B3C4D-....)
#     - Publisher display name         -> -DisplayName    (e.g. Your Name)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/set-identity.ps1 -Show
#   powershell -ExecutionPolicy Bypass -File scripts/set-identity.ps1 `
#       -IdentityName "12345PublisherName.NotesApp" `
#       -Publisher "CN=1A2B3C4D-0000-0000-0000-000000000000" `
#       -DisplayName "Your Name"

param(
    [string]$IdentityName,
    [string]$Publisher,
    [string]$DisplayName,
    [switch]$Show
)

$root = Split-Path -Parent $PSScriptRoot
$pkgPath = Join-Path $root 'package.json'
$raw = Get-Content -LiteralPath $pkgPath -Raw

if ($Show -or (-not $IdentityName -and -not $Publisher -and -not $DisplayName)) {
    $json = $raw | ConvertFrom-Json
    Write-Host ''
    Write-Host 'Current Microsoft Store identity (package.json -> build.appx):' -ForegroundColor Cyan
    Write-Host ("  identityName        : " + $json.build.appx.identityName)
    Write-Host ("  publisher           : " + $json.build.appx.publisher)
    Write-Host ("  publisherDisplayName: " + $json.build.appx.publisherDisplayName)
    Write-Host ''
    Write-Host 'Pass -IdentityName, -Publisher and -DisplayName to change them.'
    return
}

if (-not $IdentityName -or -not $Publisher -or -not $DisplayName) {
    throw 'All three values are required: -IdentityName, -Publisher, -DisplayName'
}

if ($IdentityName -notmatch '^[A-Za-z0-9.\-]+$') {
    throw "identityName '$IdentityName' contains invalid characters. Use only letters, digits, dots and hyphens."
}

if ($Publisher -notmatch '^CN=.+') {
    throw "publisher must start with 'CN=' (copy it exactly from Partner Center)."
}

function Set-JsonString {
    param([string]$Text, [string]$Key, [string]$Value)
    $escaped = $Value -replace '\\', '\\' -replace '"', '\"'
    $pattern = '("' + [regex]::Escape($Key) + '"\s*:\s*)"[^"]*"'
    $updated = [regex]::Replace($Text, $pattern, ('$1"' + $escaped + '"'), 1)
    if ($updated -eq $Text) { throw "Could not find '$Key' in package.json." }
    return $updated
}

$raw = Set-JsonString $raw 'identityName' $IdentityName
$raw = Set-JsonString $raw 'publisher' $Publisher
$raw = Set-JsonString $raw 'publisherDisplayName' $DisplayName

# Validate before writing.
$null = $raw | ConvertFrom-Json

[System.IO.File]::WriteAllText($pkgPath, $raw, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host 'Updated package.json:' -ForegroundColor Green
Write-Host ("  identityName        : " + $IdentityName)
Write-Host ("  publisher           : " + $Publisher)
Write-Host ("  publisherDisplayName: " + $DisplayName)
Write-Host ''
Write-Host 'Next: close the app, then run  npm run electron:build'
