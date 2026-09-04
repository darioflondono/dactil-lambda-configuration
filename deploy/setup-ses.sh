#!/usr/bin/env bash
# Configura Amazon SES v2 para el correo de bienvenida.
#  - Verifica la identidad del remitente (EMAIL_FROM del .env, por defecto gestion.dactil@gmail.com).
#  - Opcional: verifica destinatarios (necesario mientras la cuenta SES este en sandbox).
#  - Muestra el estado de sandbox / cuota de envio.
#
#   REGION=us-east-1 ./deploy/setup-ses.sh
#   VERIFY_RECIPIENTS="ana@empresa.com carlos@empresa.com" ./deploy/setup-ses.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

env_get() {
  local k="$1"
  [ -f "$ROOT/.env" ] || return 0
  sed -n "s/^[[:space:]]*${k}[[:space:]]*=[[:space:]]*//p" "$ROOT/.env" | head -n1 | tr -d '"'"'"'\r'
}

REGION="${REGION:-$(env_get SES_REGION)}"; REGION="${REGION:-us-east-1}"
SENDER="${SENDER:-$(env_get EMAIL_FROM)}"; SENDER="${SENDER:-gestion.dactil@gmail.com}"

echo ">> SES region : $REGION"
echo ">> remitente  : $SENDER"
echo

if aws sesv2 get-email-identity --email-identity "$SENDER" --region "$REGION" >/dev/null 2>&1; then
  echo ">> la identidad $SENDER ya esta registrada en SES"
else
  echo ">> creando identidad $SENDER"
  aws sesv2 create-email-identity --email-identity "$SENDER" --region "$REGION" >/dev/null
  echo "   AWS envio un correo de verificacion a $SENDER."
  echo "   Abre ese correo y haz clic en el enlace para completar la verificacion."
fi

STATUS="$(aws sesv2 get-email-identity --email-identity "$SENDER" --region "$REGION" \
  --query 'VerifiedForSendingStatus' --output text 2>/dev/null || echo 'UNKNOWN')"
echo "   VerifiedForSendingStatus = $STATUS"
[ "$STATUS" = "True" ] || echo "   (todavia NO verificada: SES rechazara los envios hasta que lo este)"

echo
for r in ${VERIFY_RECIPIENTS:-}; do
  if aws sesv2 get-email-identity --email-identity "$r" --region "$REGION" >/dev/null 2>&1; then
    echo ">> destinatario $r ya registrado"
  else
    aws sesv2 create-email-identity --email-identity "$r" --region "$REGION" >/dev/null
    echo ">> verificacion solicitada para destinatario $r (revisa su bandeja)"
  fi
done

echo
echo ">> estado de la cuenta SES (sandbox / cuota):"
aws sesv2 get-account --region "$REGION" \
  --query '{ProductionAccessEnabled:ProductionAccessEnabled,SendingEnabled:SendingEnabled,Max24Hour:SendQuota.Max24Hour,SentLast24Hours:SendQuota.SentLast24Hours}' \
  --output table || true

cat <<EOF

Notas:
  - Si ProductionAccessEnabled = False la cuenta esta en SANDBOX: solo se puede
    enviar DESDE y HACIA direcciones verificadas. Verifica los correos de prueba con
    VERIFY_RECIPIENTS="correo@dominio.com" ./deploy/setup-ses.sh
  - Para enviar a cualquier destinatario, pide acceso de produccion en la consola de SES
    (SES > Account dashboard > Request production access).
  - El rol de la Lambda ya incluye el permiso ses:SendEmail (deploy/iam-policy.json).
  - En .env: EMAIL_ENABLED=true, EMAIL_FROM=$SENDER, SES_REGION=$REGION.
EOF
