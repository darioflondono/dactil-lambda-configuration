#!/usr/bin/env bash
# Deploy completo a AWS en un comando:
#   DynamoDB (3 tablas) -> build zip -> IAM role -> Lambda -> API Gateway -> smoke test.
# Idempotente. Requiere AWS CLI v2 autenticada (env vars o AWS_PROFILE) y Node 20 + npm.
#
#   REGION=us-east-1 AWS_PROFILE=dactil ./deploy/deploy-all.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

export REGION="${REGION:-us-east-1}"
export AWS_DEFAULT_REGION="$REGION"
FUNCTION_NAME="${FUNCTION_NAME:-dactil-lambda-configuration}"
ROLE_NAME="${ROLE_NAME:-dactil-lambda-configuration-role}"
API_NAME="${API_NAME:-dactil-lambda-configuration-api}"

env_get() { # env_get KEY  -> lee del .env empaquetado
  local k="$1"
  [ -f "$ROOT/.env" ] || return 0
  sed -n "s/^[[:space:]]*${k}[[:space:]]*=[[:space:]]*//p" "$ROOT/.env" | head -n1 | tr -d '"'"'"'\r'
}

export TABLE_COMPANIES="$(env_get DDB_TABLE_COMPANIES)"; TABLE_COMPANIES="${TABLE_COMPANIES:-dactil-companies}"
export TABLE_USERS="$(env_get DDB_TABLE_USERS)";         TABLE_USERS="${TABLE_USERS:-dactil-users}"
export TABLE_CHANNELS="$(env_get DDB_TABLE_CHANNELS)";   TABLE_CHANNELS="${TABLE_CHANNELS:-dactil-channels}"

echo "== identidad AWS =="
aws sts get-caller-identity --query '[Account,Arn]' --output text

echo "== [1/6] DynamoDB =="
REGION="$REGION" TABLE_COMPANIES="$TABLE_COMPANIES" TABLE_USERS="$TABLE_USERS" \
  TABLE_CHANNELS="$TABLE_CHANNELS" bash "$HERE/setup-dynamodb.sh"

echo "== [2/6] SES (correo de bienvenida) =="
REGION="$REGION" bash "$HERE/setup-ses.sh" || echo "   (SES no configurado del todo; revisa la verificacion del remitente)"

echo "== [3/6] Build =="
bash "$HERE/build.sh"

echo "== [4/6] IAM =="
REGION="$REGION" ROLE_NAME="$ROLE_NAME" bash "$HERE/setup-iam.sh"

echo "== [5/6] Lambda =="
REGION="$REGION" FUNCTION_NAME="$FUNCTION_NAME" ROLE_NAME="$ROLE_NAME" bash "$HERE/deploy.sh"

echo "== [6/6] API Gateway =="
ENDPOINT="$(REGION="$REGION" FUNCTION_NAME="$FUNCTION_NAME" API_NAME="$API_NAME" bash "$HERE/setup-apigateway.sh")"
echo "endpoint: $ENDPOINT"

echo "== smoke test =="
sleep 3
curl -s "$ENDPOINT/api/v1/companies/" || true
echo

echo
echo "=== LISTO ==="
echo "Función : $FUNCTION_NAME"
echo "API     : $ENDPOINT"
echo "Prueba  : curl -s $ENDPOINT/api/v1/companies/"
