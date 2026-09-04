/**
 * Envía un correo de bienvenida de prueba por SES usando la misma función que el
 * alta de usuario, e imprime en consola si salió o no (mismo formato que CloudWatch).
 *
 *   node scripts/send-test-email.js destinatario@dominio.com ["Nombre Apellido"]
 *
 * Requiere en .env (o env vars):  EMAIL_ENABLED=true, EMAIL_FROM verificado en SES,
 * SES_REGION, y credenciales AWS (AWS_PROFILE o AWS_ACCESS_KEY_ID/SECRET).
 */
import { sendWelcomeEmail } from '../src/email.js';
import { config } from '../src/config.js';

const to = process.argv[2];
const name = process.argv[3] || 'Usuario de Prueba';

if (!to) {
  console.error('Uso: node scripts/send-test-email.js destinatario@dominio.com ["Nombre"]');
  process.exit(1);
}

console.log(
  `[test] EMAIL_ENABLED=${config.email.enabled} from=${config.email.from} ` +
    `region=${config.email.sesRegion} to=${to}`
);

const result = await sendWelcomeEmail({ to, name, tempPassword: 'Prueba-1234' });

console.log('[test] resultado:', JSON.stringify(result));
if (result.sent) {
  console.log(`[test] OK: correo enviado. messageId=${result.messageId}`);
  process.exit(0);
} else {
  console.error(`[test] NO enviado. motivo=${result.reason || 'desconocido'} error=${result.error || '-'}`);
  process.exit(2);
}
