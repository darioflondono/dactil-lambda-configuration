<#
.SYNOPSIS
  Empaqueta la Lambda Node.js en dist\function.zip (sin frameworks).
#>
[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"

$Root  = Split-Path -Parent $PSScriptRoot
$Build = Join-Path $Root "build"
$Dist  = Join-Path $Root "dist"

Remove-Item -Recurse -Force $Build, $Dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $Build, $Dist -Force | Out-Null

$npm = (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $npm) { Write-Host "ERROR: npm no encontrado en el PATH." -ForegroundColor Red; exit 1 }

Write-Host ">> Instalando dependencias de produccion"
Copy-Item (Join-Path $Root "package.json") $Build
if (Test-Path (Join-Path $Root "package-lock.json")) { Copy-Item (Join-Path $Root "package-lock.json") $Build }
Push-Location $Build
& $npm install --omit=dev --no-audit --no-fund --silent
$rc = $LASTEXITCODE
Pop-Location
if ($rc -ne 0) { Write-Host "ERROR: npm install fallo." -ForegroundColor Red; exit 1 }

Write-Host ">> Copiando codigo + .env"
Copy-Item -Recurse (Join-Path $Root "src") (Join-Path $Build "src")
if (Test-Path (Join-Path $Root ".env")) { Copy-Item (Join-Path $Root ".env") (Join-Path $Build ".env") }

Write-Host ">> Generando zip"
$zip = Join-Path $Dist "function.zip"
Get-ChildItem -Recurse $Build -Filter *.map | Remove-Item -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $Build "*") -DestinationPath $zip -CompressionLevel Optimal -Force

$zipMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ">> Listo: dist\function.zip ($zipMB MB)"
