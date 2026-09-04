import { randomUUID } from 'node:crypto';
import { badRequest } from './errors.js';

export const nowIso = () => new Date().toISOString();
export const uuid = () => randomUUID();

export function str(v, field) {
  if (typeof v !== 'string' || v.trim() === '') throw badRequest(`El campo '${field}' es requerido`);
  return v.trim();
}

export function optStr(v) {
  return typeof v === 'string' ? v.trim() : undefined;
}

export function oneOf(v, allowed, field) {
  if (!allowed.includes(v)) throw badRequest(`'${field}' debe ser uno de: ${allowed.join(', ')}`);
  return v;
}

export function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function toArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean);
  return [];
}

export function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
