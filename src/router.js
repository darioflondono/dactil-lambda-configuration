import * as companies from './controllers/companies.js';
import * as users from './controllers/users.js';
import * as channels from './controllers/channels.js';
import { notFound } from './errors.js';

// [método, regex(path), handler]  — el path ya viene normalizado (sin /api/v1, sin barra final)
const ROUTES = [
  ['GET', /^\/companies$/, companies.list],
  ['POST', /^\/companies$/, companies.create],
  ['GET', /^\/companies\/(?<id>[^/]+)$/, companies.get],
  ['PUT', /^\/companies\/(?<id>[^/]+)$/, companies.update],
  ['DELETE', /^\/companies\/(?<id>[^/]+)$/, companies.remove],

  ['POST', /^\/auth\/set-password$/, users.setPassword],

  ['GET', /^\/users$/, users.list],
  ['POST', /^\/users$/, users.create],
  ['GET', /^\/users\/(?<id>[^/]+)$/, users.get],
  ['PUT', /^\/users\/(?<id>[^/]+)$/, users.update],
  ['DELETE', /^\/users\/(?<id>[^/]+)$/, users.remove],

  ['GET', /^\/channels$/, channels.list],
  ['POST', /^\/channels$/, channels.create],
  ['GET', /^\/channels\/(?<id>[^/]+)$/, channels.get],
  ['PUT', /^\/channels\/(?<id>[^/]+)$/, channels.update],
  ['DELETE', /^\/channels\/(?<id>[^/]+)$/, channels.remove]
];

/** Normaliza el path: quita querystring, prefijo /api/v1 y barra final. */
export function normalizePath(rawPath) {
  let p = (rawPath || '/').split('?')[0];
  const marker = p.indexOf('/api/v1');
  if (marker >= 0) p = p.slice(marker + '/api/v1'.length);
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

const KNOWN_PREFIXES = ['/companies', '/users', '/channels', '/auth'];

export function match(method, path) {
  for (const [m, re, handler] of ROUTES) {
    if (m !== method) continue;
    const mm = re.exec(path);
    if (!mm) continue;
    const params = {};
    for (const [k, v] of Object.entries(mm.groups || {})) params[k] = decodeURIComponent(v);
    return { handler, params };
  }
  // ¿ruta conocida pero método equivocado? -> 405
  if (KNOWN_PREFIXES.some((pre) => path === pre || path.startsWith(pre + '/'))) {
    const err = notFound(`Método ${method} no permitido en ${path}`);
    err.status = 405;
    err.code = 'METHOD_NOT_ALLOWED';
    throw err;
  }
  throw notFound(`Ruta no encontrada: ${method} ${path}`);
}
