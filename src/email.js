import { config } from './config.js';

let sesClientPromise;
async function getSes() {
  if (!sesClientPromise) {
    sesClientPromise = import('@aws-sdk/client-sesv2').then(
      ({ SESv2Client }) => new SESv2Client({ region: config.email.sesRegion })
    );
  }
  return sesClientPromise;
}

/**
 * Envía el correo de bienvenida con la contraseña temporal y el enlace de activación
 * usando Amazon SES v2. Nunca lanza: devuelve el resultado y deja trazas en consola
 * (CloudWatch) para poder validar si el correo salió o no.
 *
 * @returns {Promise<{sent:boolean, messageId?:string, reason?:string, error?:string, link:string}>}
 */
export async function sendWelcomeEmail({ to, name, tempPassword }) {
  const link = `${config.email.portalBaseUrl}/activar?email=${encodeURIComponent(to)}`;
  const from = config.email.fromName ? `${config.email.fromName} <${config.email.from}>` : config.email.from;

  if (!config.email.enabled) {
    console.log(`[email] EMAIL_ENABLED=false -> correo NO enviado. to=${to} link=${link}`);
    return { sent: false, reason: 'disabled', link };
  }

  const subject = 'Bienvenido a Dáctil';
  const text = [
    `Hola ${name || ''}`.trim() + ',',
    '',
    'Se creó tu cuenta en Dáctil. Tienes una contraseña temporal:',
    '',
    `    ${tempPassword}`,
    '',
    'Actívala definiendo tu contraseña en este enlace:',
    link,
    '',
    'Ahí ingresas tu correo y la contraseña temporal, y estableces tu contraseña definitiva.',
    '',
    '— Equipo Dáctil'
  ].join('\n');

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:auto;color:#0f1b33">
      <h2 style="margin:0 0 12px">Bienvenido a Dáctil</h2>
      <p>Hola ${escapeHtml(name || '')},</p>
      <p>Se creó tu cuenta. Tienes una <strong>contraseña temporal</strong>:</p>
      <p style="font-size:20px;letter-spacing:2px;background:#f1f5f9;padding:10px 14px;border-radius:8px;display:inline-block">
        ${escapeHtml(tempPassword)}
      </p>
      <p>Actívala definiendo tu contraseña:</p>
      <p>
        <a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">
          Activar mi cuenta
        </a>
      </p>
      <p style="color:#64748b;font-size:13px">Si el botón no funciona, copia este enlace:<br>${link}</p>
      <p style="color:#64748b;font-size:13px">— Equipo Dáctil</p>
    </div>`;

  const t0 = Date.now();
  try {
    const { SendEmailCommand } = await import('@aws-sdk/client-sesv2');
    const ses = await getSes();
    const resp = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              Html: { Data: html, Charset: 'UTF-8' }
            }
          }
        }
      })
    );
    const messageId = resp?.MessageId;
    console.log(
      `[email] OK correo de bienvenida ENVIADO por SES. to=${to} from=${config.email.from} ` +
        `region=${config.email.sesRegion} messageId=${messageId} ms=${Date.now() - t0}`
    );
    return { sent: true, messageId, link };
  } catch (e) {
    console.error(
      `[email] ERROR SES al enviar correo de bienvenida. to=${to} from=${config.email.from} ` +
        `region=${config.email.sesRegion} name=${e.name} message=${e.message} ms=${Date.now() - t0}`
    );
    return { sent: false, reason: e.name || 'error', error: e.message, link };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
