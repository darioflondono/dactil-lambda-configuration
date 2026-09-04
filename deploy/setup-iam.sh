#!/usr/bin/env bash
# Crea el rol de ejecución de la Lambda y le adjunta deploy/iam-policy.json. Idempotente.
#   REGION=us-east-1 ROLE_NAME=dactil-lambda-configuration-role ./deploy/setup-iam.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="${REGION:-us-east-1}"
ROLE_NAME="${ROLE_NAME:-dactil-lambda-configuration-role}"
POLICY_NAME="${POLICY_NAME:-dactil-lambda-configuration-policy}"

TRUST=$(cat <<'JSON'
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
)

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  echo ">> rol $ROLE_NAME ya existe"
else
  echo ">> creando rol $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST" >/dev/null
  echo ">> esperando propagación de IAM (10s)"; sleep 10
fi

echo ">> adjuntando política $POLICY_NAME"
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "file://$HERE/iam-policy.json"

aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text
