<#
.SYNOPSIS
  Deploy completo de dactil-lambda-configuration a AWS en un comando:
  DynamoDB (3 tablas) -> build zip -> IAM role -> Lambda -> API Gateway -> smoke test.

.DESCRIPTION
  Idempotente: seguro re-ejecutar. Crea lo que falta, actualiza lo que existe.
  Credenciales: por parametros (-AwsAccessKeyId/-AwsSecretAccessKey[/-AwsSessionToken]),
  un perfil (-AwsProfile), o lo que ya este en el entorno.

.EXAMPLE
  .\deploy\deploy-all.ps1 -AwsProfile dactil -Region us-east-1
#>
[CmdletBinding()]
param(
  [string]$Region       = "us-east-1",
  [string]$FunctionName = "dactil-lambda-configuration",
  [string]$RoleName     = "dactil-lambda-configuration-role",
  [string]$ApiName      = "dactil-lambda-configuration-api",
  [string]$Runtime      = "nodejs20.x",
  [string]$Handler      = "src/handler.handler",
  [int]$MemorySize      = 256,
  [int]$Timeout         = 30,

  [string]$AwsAccessKeyId     = "",
  [string]$AwsSecretAccessKey = "",
  [string]$AwsSessionToken    = "",
  [string]$AwsProfile         = "",

  [switch]$SkipBuild,
  [switch]$NoApiGateway
)

$ErrorActionPreference = "Stop"
$Root   = Split-Path -Parent $PSScriptRoot
$Deploy = Join-Path $Root "deploy"
$Zip    = Join-Path $Root "dist\function.zip"
$Tmp    = Join-Path ([IO.Path]::GetTempPath()) ("dactilcfg-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

$AwsCmd = Get-Command -Name aws -CommandType Application, ExternalScript -ErrorAction SilentlyContinue |
          Select-Object -First 1

function Fail($m) {
  Write-Host "ERROR: $m" -ForegroundColor Red
  Remove-Item -Recurse -Force $Tmp -EA SilentlyContinue
  exit 1
}
function RunAws {
  param([Parameter(ValueFromRemainingArguments)]$Rest)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $lines = & $script:AwsExe @Rest 2>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) {
      if ($_.TargetObject) { [string]$_.TargetObject } else { [string]$_.Exception.Message }
    } else { [string]$_ }
  }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $text = (($lines | Where-Object { $_ -and $_.Trim() }) -join "`n")
  if ($code -ne 0) { throw ("aws " + ($Rest -join ' ') + " -> exit $code`n" + $text) }
  return $text
}
function TryAws {
  param([Parameter(ValueFromRemainingArguments)]$Rest)
  try { RunAws @Rest | Out-Null; return $true } catch { return $false }
}
function WriteJson($obj, $path) {
  ($obj | ConvertTo-Json -Depth 20) | Out-File -FilePath $path -Encoding ascii
}
function Get-EnvVal($file, $key) {
  if (-not (Test-Path $file)) { return "" }
  $m = Select-String -Path $file -Pattern ("^\s*" + [regex]::Escape($key) + "\s*=(.*)$") | Select-Object -First 1
  if (-not $m) { return "" }
  $v = $m.Matches[0].Groups[1].Value.Trim()
  $v = $v -replace '^"(.*)"$', '$1'
  $v = $v -replace "^'(.*)'$", '$1'
  return $v
}

if (-not $AwsCmd) { Fail "AWS CLI ('aws') no encontrada en el PATH. Instala AWS CLI v2." }
$script:AwsExe = $AwsCmd.Source
Write-Host ">> aws : $($AwsCmd.Source)"

if ($AwsProfile)     { $env:AWS_PROFILE = $AwsProfile }
if ($AwsAccessKeyId) {
  $env:AWS_ACCESS_KEY_ID     = $AwsAccessKeyId
  $env:AWS_SECRET_ACCESS_KEY = $AwsSecretAccessKey
  if ($AwsSessionToken) { $env:AWS_SESSION_TOKEN = $AwsSessionToken }
}
$env:AWS_DEFAULT_REGION = $Region
$env:AWS_REGION         = $Region

Write-Host ">> identidad AWS"
$Account = (RunAws sts get-caller-identity --query Account --output text).Trim()
Write-Host "   cuenta $Account / region $Region"

$DotEnv = Join-Path $Root ".env"
$TblCompanies = Get-EnvVal $DotEnv "DDB_TABLE_COMPANIES"; if (-not $TblCompanies) { $TblCompanies = "dactil-companies" }
$TblUsers     = Get-EnvVal $DotEnv "DDB_TABLE_USERS";     if (-not $TblUsers)     { $TblUsers     = "dactil-users" }
$TblChannels  = Get-EnvVal $DotEnv "DDB_TABLE_CHANNELS";  if (-not $TblChannels)  { $TblChannels  = "dactil-channels" }
Write-Host "   tablas (de .env): $TblCompanies / $TblUsers / $TblChannels"

# ---------------------------------------------------------------- 1. DynamoDB
Write-Host ">> [1/5] DynamoDB"
function New-Table($name, $pk) {
  if (TryAws dynamodb describe-table --table-name $name --region $Region) {
    Write-Host "   $name ya existe"; return
  }
  Write-Host "   creando $name (PK: $pk)"
  RunAws dynamodb create-table --region $Region --table-name $name `
    --billing-mode PAY_PER_REQUEST `
    --attribute-definitions "AttributeName=$pk,AttributeType=S" `
    --key-schema "AttributeName=$pk,KeyType=HASH" | Out-Null
  RunAws dynamodb wait table-exists --table-name $name --region $Region | Out-Null
}
New-Table $TblCompanies "identification"
New-Table $TblUsers     "identification"
New-Table $TblChannels  "id"

# ---------------------------------------------------------------- 1b. SES (correo)
Write-Host ">> [1b/5] SES (correo de bienvenida)"
$EmailEnabled = Get-EnvVal $DotEnv "EMAIL_ENABLED"
$EmailFrom    = Get-EnvVal $DotEnv "EMAIL_FROM"
$SesRegion    = Get-EnvVal $DotEnv "SES_REGION"; if (-not $SesRegion) { $SesRegion = $Region }
if ($EmailEnabled -match '^(1|true|yes|on)$' -and $EmailFrom) {
  $idJson = $null
  $idExists = TryAws sesv2 get-email-identity --email-identity $EmailFrom --region $SesRegion
  if (-not $idExists) {
    Write-Host "   registrando identidad de remitente $EmailFrom"
    TryAws sesv2 create-email-identity --email-identity $EmailFrom --region $SesRegion | Out-Null
    Write-Host "   AWS envio un correo de verificacion a $EmailFrom -> abrelo y confirma el enlace"
  }
  $vstatus = (RunAws sesv2 get-email-identity --email-identity $EmailFrom --region $SesRegion `
    --query 'VerifiedForSendingStatus' --output text)
  Write-Host "   $EmailFrom VerifiedForSendingStatus = $($vstatus.Trim())"
  if ($vstatus.Trim() -ne 'True') {
    Write-Host "   OJO: hasta verificar $EmailFrom, SES rechazara el envio del correo de bienvenida" -ForegroundColor Yellow
  }
  $prodJson = (RunAws sesv2 get-account --region $SesRegion --query 'ProductionAccessEnabled' --output text)
  if ($prodJson.Trim() -ne 'True') {
    Write-Host "   SES en SANDBOX: solo envia a destinatarios verificados. Verificalos con:" -ForegroundColor Yellow
    Write-Host "     VERIFY_RECIPIENTS='correo@dominio.com' bash deploy/setup-ses.sh" -ForegroundColor Yellow
  }
} else {
  Write-Host "   EMAIL_ENABLED != true o EMAIL_FROM vacio en .env -> se omite SES"
}

# ---------------------------------------------------------------- 2. build
if (-not $SkipBuild) {
  Write-Host ">> [2/5] Build zip"
  & (Join-Path $Deploy "build.ps1")
  if ($LASTEXITCODE -ne 0) { Fail "build.ps1 fallo." }
}
if (-not (Test-Path $Zip)) { Fail "$Zip no existe. Ejecuta sin -SkipBuild." }
$ZipMB = [math]::Round((Get-Item $Zip).Length / 1MB, 1)
Write-Host "   dist/function.zip = $ZipMB MB"

# ---------------------------------------------------------------- 3. IAM
Write-Host ">> [3/5] Rol de ejecucion IAM"
$trust = @{ Version = "2012-10-17"; Statement = @(
  @{ Effect = "Allow"; Principal = @{ Service = "lambda.amazonaws.com" }; Action = "sts:AssumeRole" }) }
$policy = @{ Version = "2012-10-17"; Statement = @(
  @{ Sid = "Logs"; Effect = "Allow";
     Action = @("logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents");
     Resource = "arn:aws:logs:${Region}:${Account}:*" },
  @{ Sid = "DynamoDbCrud"; Effect = "Allow";
     Action = @("dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem",
                "dynamodb:DeleteItem","dynamodb:Scan","dynamodb:Query");
     Resource = @(
       "arn:aws:dynamodb:${Region}:${Account}:table/$TblCompanies",
       "arn:aws:dynamodb:${Region}:${Account}:table/$TblUsers",
       "arn:aws:dynamodb:${Region}:${Account}:table/$TblUsers/index/*",
       "arn:aws:dynamodb:${Region}:${Account}:table/$TblChannels") },
  @{ Sid = "SendWelcomeEmail"; Effect = "Allow"; Action = @("ses:SendEmail"); Resource = "*" },
  @{ Sid = "ProvisionChannelS3Buckets"; Effect = "Allow";
     Action = @("s3:CreateBucket","s3:ListBucket","s3:GetBucketLocation","s3:PutBucketPublicAccessBlock","s3:PutObject");
     Resource = @("arn:aws:s3:::*","arn:aws:s3:::*/*") }) }
$trustFile  = Join-Path $Tmp "trust.json";  WriteJson $trust  $trustFile
$policyFile = Join-Path $Tmp "policy.json"; WriteJson $policy $policyFile

$roleExists = TryAws iam get-role --role-name $RoleName
if (-not $roleExists) {
  Write-Host "   creando rol $RoleName"
  RunAws iam create-role --role-name $RoleName --assume-role-policy-document "file://$trustFile" | Out-Null
}
RunAws iam put-role-policy --role-name $RoleName --policy-name dactil-lambda-configuration-policy `
  --policy-document "file://$policyFile" | Out-Null
$RoleArn = (RunAws iam get-role --role-name $RoleName --query 'Role.Arn' --output text).Trim()
Write-Host "   $RoleArn"
if (-not $roleExists) { Write-Host "   esperando propagacion de IAM (15s)"; Start-Sleep -Seconds 15 }

# ---------------------------------------------------------------- 4. Lambda
Write-Host ">> [4/5] Funcion Lambda"
$fnExists = TryAws lambda get-function --function-name $FunctionName --region $Region
if ($fnExists) {
  Write-Host "   actualizando codigo"
  RunAws lambda update-function-code --function-name $FunctionName --region $Region `
    --zip-file "fileb://$Zip" --publish | Out-Null
  RunAws lambda wait function-updated --function-name $FunctionName --region $Region | Out-Null
  Write-Host "   actualizando configuracion"
  RunAws lambda update-function-configuration --function-name $FunctionName --region $Region `
    --runtime $Runtime --handler $Handler --timeout $Timeout --memory-size $MemorySize | Out-Null
  RunAws lambda wait function-updated --function-name $FunctionName --region $Region | Out-Null
} else {
  Write-Host "   creando funcion $FunctionName"
  RunAws lambda create-function --function-name $FunctionName --region $Region `
    --runtime $Runtime --architectures x86_64 --handler $Handler `
    --role $RoleArn --timeout $Timeout --memory-size $MemorySize `
    --zip-file "fileb://$Zip" | Out-Null
  RunAws lambda wait function-active --function-name $FunctionName --region $Region | Out-Null
}
$FnArn = (RunAws lambda get-function --function-name $FunctionName --region $Region `
  --query 'Configuration.FunctionArn' --output text).Trim()
Write-Host "   $FnArn"

# ---------------------------------------------------------------- 5. API Gateway
$Endpoint = $null
if (-not $NoApiGateway) {
  Write-Host ">> [5/5] API Gateway (HTTP API + proxy)"
  $apiId = (RunAws apigatewayv2 get-apis --region $Region `
    --query "Items[?Name=='$ApiName'].ApiId | [0]" --output text).Trim()
  if (-not $apiId -or $apiId -eq "None") {
    Write-Host "   creando HTTP API $ApiName"
    $apiId = (RunAws apigatewayv2 create-api --region $Region --name $ApiName `
      --protocol-type HTTP --target $FnArn --query ApiId --output text).Trim()
  } else {
    Write-Host "   reusando API $apiId"
  }
  $srcArn = "arn:aws:execute-api:${Region}:${Account}:$apiId/*/*"
  TryAws lambda add-permission --function-name $FunctionName --region $Region `
    --statement-id "apigw-$apiId" --action lambda:InvokeFunction `
    --principal apigateway.amazonaws.com --source-arn $srcArn | Out-Null
  $Endpoint = (RunAws apigatewayv2 get-api --api-id $apiId --region $Region `
    --query ApiEndpoint --output text).Trim()
  Write-Host "   $Endpoint"
} else {
  Write-Host ">> [5/5] API Gateway omitido (-NoApiGateway)"
}

# ---------------------------------------------------------------- smoke test
Write-Host ""
Write-Host "=== Smoke test ==="
$hp = Join-Path $Tmp "ev.json"
'{"version":"2.0","rawPath":"/api/v1/companies/","requestContext":{"http":{"method":"GET"}}}' |
  Out-File -FilePath $hp -Encoding ascii
$outFile = Join-Path $Tmp "out.json"
RunAws lambda invoke --function-name $FunctionName --region $Region `
  --payload "fileb://$hp" --cli-binary-format raw-in-base64-out $outFile | Out-Null
Write-Host ("invoke GET /api/v1/companies/ -> " + ((Get-Content $outFile -Raw).Trim()))
if ($Endpoint) {
  try {
    $r = Invoke-RestMethod -Uri "$Endpoint/api/v1/companies/" -TimeoutSec 30
    Write-Host ("GET /api/v1/companies/ -> " + ($r | ConvertTo-Json -Compress))
  } catch {
    Write-Host ("GET /api/v1/companies/ -> FALLO: " + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host "   (una API GW recien creada puede tardar unos segundos)" -ForegroundColor Yellow
  }
}

Remove-Item -Recurse -Force $Tmp -EA SilentlyContinue

Write-Host ""
Write-Host "=== LISTO ===" -ForegroundColor Green
Write-Host "Funcion : $FnArn"
Write-Host "Rol     : $RoleArn"
if ($Endpoint) { Write-Host "API     : $Endpoint" }
