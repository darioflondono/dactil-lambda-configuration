#!/usr/bin/env bash
# Crea las 3 tablas de DynamoDB (on-demand). Idempotente.
#   REGION=us-east-1 \
#   TABLE_COMPANIES=dactil-companies TABLE_USERS=dactil-users TABLE_CHANNELS=dactil-channels \
#   ./deploy/setup-dynamodb.sh
set -euo pipefail

REGION="${REGION:-us-east-1}"
TABLE_COMPANIES="${TABLE_COMPANIES:-dactil-companies}"
TABLE_USERS="${TABLE_USERS:-dactil-users}"
TABLE_CHANNELS="${TABLE_CHANNELS:-dactil-channels}"

create() {
  local name="$1" pk="$2"
  if aws dynamodb describe-table --table-name "$name" --region "$REGION" >/dev/null 2>&1; then
    echo ">> $name ya existe"
    return
  fi
  echo ">> creando $name (PK: $pk)"
  aws dynamodb create-table --region "$REGION" \
    --table-name "$name" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName="$pk",AttributeType=S \
    --key-schema AttributeName="$pk",KeyType=HASH >/dev/null
  aws dynamodb wait table-exists --table-name "$name" --region "$REGION"
}

create "$TABLE_COMPANIES" identification
create "$TABLE_USERS"     identification
create "$TABLE_CHANNELS"  id

echo ">> Listo. Tablas:"
aws dynamodb list-tables --region "$REGION" --query 'TableNames' --output text

# Nota: para escalar la búsqueda de usuarios por correo (set-password), añade un GSI:
#   aws dynamodb update-table --table-name "$TABLE_USERS" --region "$REGION" \
#     --attribute-definitions AttributeName=email,AttributeType=S \
#     --global-secondary-index-updates '[{"Create":{"IndexName":"by-email",
#       "KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],
#       "Projection":{"ProjectionType":"ALL"}}}]'
# y cambia findByEmail() en src/controllers/users.js por un QueryCommand sobre 'by-email'.
