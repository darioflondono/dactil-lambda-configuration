#!/usr/bin/env bash
# Expone la Lambda por una HTTP API (API Gateway v2) con proxy ANY /{proxy+}.
#   REGION=us-east-1 FUNCTION_NAME=dactil-lambda-configuration \
#   API_NAME=dactil-lambda-configuration-api ./deploy/setup-apigateway.sh
set -euo pipefail

REGION="${REGION:-us-east-1}"
FUNCTION_NAME="${FUNCTION_NAME:-dactil-lambda-configuration}"
API_NAME="${API_NAME:-dactil-lambda-configuration-api}"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
FN_ARN="$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text)"

API_ID="$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)"

if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  echo ">> creando HTTP API $API_NAME"
  API_ID="$(aws apigatewayv2 create-api --region "$REGION" --name "$API_NAME" \
    --protocol-type HTTP --target "$FN_ARN" \
    --cors-configuration AllowOrigins='*',AllowMethods='*',AllowHeaders='*' \
    --query ApiId --output text)"
else
  echo ">> reutilizando API $API_ID"
fi

aws lambda add-permission --function-name "$FUNCTION_NAME" --region "$REGION" \
  --statement-id "apigw-$API_ID" --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*/*" >/dev/null 2>&1 || true

aws apigatewayv2 get-api --api-id "$API_ID" --region "$REGION" \
  --query ApiEndpoint --output text
