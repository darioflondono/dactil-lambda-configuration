import './config.js'; // carga .env
import { match, normalizePath } from './router.js';
import { checkAuth } from './auth.js';
import { ok, fail, noContent } from './responses.js';
import { ApiError } from './errors.js';

/** Normaliza un evento de API Gateway (payload v1 o v2) o invocación directa. */
function parseEvent(event) {
  if (typeof event === 'string') event = JSON.parse(event);
  const rc = event.requestContext || {};

  let method = 'GET';
  let rawPath = '/';
  if (event.version === '2.0' || rc.http) {
    method = (rc.http?.method || event.httpMethod || 'GET').toUpperCase();
    rawPath = event.rawPath || rc.http?.path || '/';
    if (event.routeKey && event.routeKey !== '$default' && event.routeKey.includes(' ')) {
      const [m, p] = event.routeKey.split(' ');
      method = m.toUpperCase();
      rawPath = p;
    }
  } else if (event.httpMethod) {
    method = event.httpMethod.toUpperCase();
    rawPath = event.path || event.resource || '/';
  } else {
    // invocación directa: { method, path, body }
    method = (event.method || 'GET').toUpperCase();
    rawPath = event.path || '/';
  }

  const headers = {};
  for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;

  let body = {};
  if (typeof event.body === 'string' && event.body.length) {
    const decoded = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    try {
      body = JSON.parse(decoded);
    } catch {
      body = {};
    }
  } else if (event.body && typeof event.body === 'object') {
    body = event.body; // invocación directa con { method, path, body }
  } else if (!event.requestContext && !event.httpMethod && typeof event === 'object' && !event.rawPath) {
    // invocación directa donde el evento ES el cuerpo
    const { method: _m, path: _p, headers: _h, ...rest } = event;
    body = rest;
  }

  return { method, path: normalizePath(rawPath), headers, body, rawPath };
}

export const handler = async (event) => {
  let req;
  try {
    req = parseEvent(event);
  } catch (e) {
    return fail(400, `Evento inválido: ${e.message}`, 'BAD_EVENT');
  }

  if (req.method === 'OPTIONS') return noContent();

  try {
    const auth = checkAuth(req);
    const { handler: routeHandler, params } = match(req.method, req.path);
    const result = await routeHandler({ ...req, params, auth });

    const isCreate = req.method === 'POST' && /^\/(companies|users|channels)$/.test(req.path);
    return ok(result, isCreate ? 201 : 200);
  } catch (e) {
    if (e instanceof ApiError) return fail(e.status, e.message, e.code);

    // Errores de DynamoDB / SDK
    if (e.name === 'ResourceNotFoundException') {
      return fail(500, 'La tabla de DynamoDB no existe. Créala con deploy/setup-dynamodb.sh', 'TABLE_NOT_FOUND');
    }
    if (e.name === 'ConditionalCheckFailedException') {
      return fail(409, 'Conflicto de datos', 'CONFLICT');
    }
    console.error('[handler] error no controlado:', e);
    return fail(500, `Error interno: ${e.message}`, 'INTERNAL');
  }
};
