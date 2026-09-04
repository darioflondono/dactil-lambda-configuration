import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { forbidden, unauthorized } from './errors.js';

const scrypt = promisify(_scrypt);

// ─────────────────────────────────────────── hash de contraseñas (scrypt)
export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const dk = await scrypt(plain + config.passwordPepper, salt, 64);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const [, saltHex, hashHex] = stored.split('$');
  try {
    const dk = await scrypt(plain + config.passwordPepper, Buffer.from(saltHex, 'hex'), 64);
    const ref = Buffer.from(hashHex, 'hex');
    return dk.length === ref.length && timingSafeEqual(dk, ref);
  } catch {
    return false;
  }
}

export function randomTempPassword(len = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// ─────────────────────────────────────────── JWT HS256 (verificación mínima)
function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Verifica un JWT HS256. Lanza unauthorized() si es inválido. Devuelve el payload. */
export function verifyJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw unauthorized('Token mal formado');
  const [h, p, sig] = parts;

  const expected = createHmac('sha256', config.auth.jwtSecret).update(`${h}.${p}`).digest();
  const got = b64urlToBuf(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw unauthorized('Firma de token inválida');
  }

  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  } catch {
    throw unauthorized('Payload de token inválido');
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) throw unauthorized('Token expirado');
  return payload;
}

/** Middleware: aplica auth solo si REQUIRE_AUTH=true. */
export function checkAuth(req) {
  if (!config.auth.required) return null;
  if (!config.auth.jwtSecret) throw unauthorized('REQUIRE_AUTH=true pero falta JWT_SECRET');
  const header = req.headers['authorization'] || '';
  if (!header.startsWith('Bearer ')) throw unauthorized('Falta cabecera Authorization: Bearer <token>');
  return verifyJwt(header.slice(7));
}

/**
 * Exige que `auth.role` esté en `allowed`. No hace nada si `auth` es null (REQUIRE_AUTH=false,
 * modo abierto/dev): el gating por rol solo es una restricción real cuando la auth está activa.
 */
export function requireRole(auth, allowed) {
  if (auth && !allowed.includes(auth.role)) throw forbidden(`Requiere rol: ${allowed.join(' o ')}`);
}
