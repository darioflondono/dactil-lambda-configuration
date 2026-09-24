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
 * Traza de una línea en CloudWatch con el resultado del envío:
 *   [email] SENT|FAILED|DISABLED {"status":...,"to":...,"error":...,"hint":...}
 * En la consola de CloudWatch se filtra con el texto "[email] FAILED".
 */
function logEmail(status, fields) {
  const line = `[email] ${status} ${JSON.stringify({ status, ...fields })}`;
  if (status === 'FAILED') console.error(line);
  else console.log(line);
}

/** Traduce los errores comunes de SES a una indicación accionable. */
function hintFor(e) {
  const msg = e?.message || '';
  if (e?.name === 'MessageRejected' && /not verified/i.test(msg)) {
    return /failed the check/i.test(msg) && !msg.includes(config.email.from)
      ? 'SES está en sandbox: el destinatario no está verificado. Verifícalo en SES o solicita acceso a producción.'
      : `El remitente ${config.email.from} no está verificado en SES (${config.email.sesRegion}).`;
  }
  if (e?.name === 'AccessDeniedException') return 'El rol de la Lambda no tiene permiso ses:SendEmail.';
  if (e?.name === 'AccountSuspendedException' || e?.name === 'SendingPausedException') {
    return 'El envío de SES está suspendido o pausado en la cuenta.';
  }
  if (e?.name === 'TooManyRequestsException' || e?.name === 'LimitExceededException') {
    return 'Se superó la cuota o tasa de envío de SES.';
  }
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|timeout/i.test(`${e?.name} ${e?.code} ${msg}`)) {
    return 'Error de comunicación con SES (red/timeout). Reintenta.';
  }
  return undefined;
}

/**
 * Envía el correo de bienvenida con la contraseña temporal y el enlace de activación
 * usando Amazon SES v2. Nunca lanza: devuelve el resultado y deja trazas en consola
 * (CloudWatch) para poder validar si el correo salió o no.
 *
 * @returns {Promise<{sent:boolean, status:'SENT'|'FAILED'|'DISABLED', messageId?:string,
 *   reason?:string, error?:string, hint?:string, link:string}>}
 */
export async function sendWelcomeEmail({ to, name, tempPassword }) {
  const link = `${config.email.portalBaseUrl}/activar?email=${encodeURIComponent(to)}`;
  const from = config.email.fromName ? `${config.email.fromName} <${config.email.from}>` : config.email.from;

  if (!config.email.enabled) {
    const hint = 'EMAIL_ENABLED=false: el envío de correos está desactivado.';
    logEmail('DISABLED', { to, from: config.email.from, hint });
    return { sent: false, status: 'DISABLED', reason: 'disabled', hint, link };
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
    logEmail('SENT', {
      to,
      from: config.email.from,
      region: config.email.sesRegion,
      messageId,
      ms: Date.now() - t0
    });
    return { sent: true, status: 'SENT', messageId, link };
  } catch (e) {
    const hint = hintFor(e);
    logEmail('FAILED', {
      to,
      from: config.email.from,
      region: config.email.sesRegion,
      error_name: e.name,
      error: e.message,
      http_status: e.$metadata?.httpStatusCode,
      request_id: e.$metadata?.requestId,
      hint,
      ms: Date.now() - t0
    });
    return { sent: false, status: 'FAILED', reason: e.name || 'error', error: e.message, hint, link };
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
