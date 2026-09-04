#!/usr/bin/env bash
# Crea o actualiza la función Lambda con dist/function.zip.
# Requiere: dist/function.zip (deploy/build.sh) y el rol (deploy/setup-iam.sh).
#   REGION=us-east-1 FUNCTION_NAME=dactil-lambda-configuration \
#   ROLE_NAME=dactil-lambda-configuration-role ./deploy/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP="$ROOT/dist/function.zip"
REGION="${REGION:-us-east-1}"
FUNCTION_NAME="${FUNCTION_NAME:-dactil-lambda-configuration}"
ROLE_NAME="${ROLE_NAME:-dactil-lambda-configuration-role}"
RUNTIME="${RUNTIME:-nodejs20.x}"
HANDLER="${HANDLER:-src/handler.handler}"
MEMORY="${MEMORY:-256}"
TIMEOUT="${TIMEOUT:-30}"

[ -f "$ZIP" ] || { echo "Falta $ZIP. Corre deploy/build.sh (o build.ps1) primero."; exit 1; }

ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)"

if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" >/dev/null 2>&1; then
  echo ">> actualizando código de $FUNCTION_NAME"
  aws lambda update-function-code --function-name "$FUNCTION_NAME" --region "$REGION" \
    --zip-file "fileb://$ZIP" --publish >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
  echo ">> actualizando configuración"
  aws lambda update-function-configuration --function-name "$FUNCTION_NAME" --region "$REGION" \
    --runtime "$RUNTIME" --handler "$HANDLER" --memory-size "$MEMORY" --timeout "$TIMEOUT" >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"
else
  echo ">> creando función $FUNCTION_NAME"
  aws lambda create-function --function-name "$FUNCTION_NAME" --region "$REGION" \
    --runtime "$RUNTIME" --architectures x86_64 --handler "$HANDLER" \
    --role "$ROLE_ARN" --memory-size "$MEMORY" --timeout "$TIMEOUT" \
    --zip-file "fileb://$ZIP" >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION_NAME" --region "$REGION"
fi

aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text
