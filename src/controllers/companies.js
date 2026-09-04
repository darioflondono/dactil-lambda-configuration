import { TABLES, getItem, putItem, updateItem, deleteItem, scanAll } from '../db.js';
import { requireRole } from '../auth.js';
import { conflict, notFound } from '../errors.js';
import { nowIso, oneOf, str } from '../util.js';

const T = () => TABLES.companies;
const STATUSES = ['active', 'inactive'];

function toDto(item) {
  if (!item) return null;
  return {
    identification: item.identification,
    name: item.name,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

// GET /companies/   -> implementador ve todas; administrador/invitado solo la propia.
export async function list({ auth } = {}) {
  const items = await scanAll(T());
  const all = items.map(toDto).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (!auth || auth.role === 'implementador') return all;
  return all.filter((c) => c.identification === auth.company_id);
}

// GET /companies/{identification}
export async function get({ params, auth }) {
  const item = await getItem(T(), { identification: params.id });
  if (!item) throw notFound('Empresa no encontrada');
  if (auth && auth.role !== 'implementador' && params.id !== auth.company_id) {
    throw notFound('Empresa no encontrada');
  }
  return toDto(item);
}

// POST /companies/   <- { identification, name, status }   (solo implementador)
export async function create({ body, auth }) {
  requireRole(auth, ['implementador']);
  const identification = str(body.identification, 'identification');
  const name = str(body.name, 'name');
  const status = oneOf(body.status ?? 'active', STATUSES, 'status');

  const ts = nowIso();
  const item = { identification, name, status, created_at: ts, updated_at: ts };

  try {
    await putItem(T(), item, { mustNotExist: { identification: true } });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw conflict('Ya existe una empresa con esa identificación');
    throw e;
  }
  return toDto(item);
}

// PUT /companies/{identification}   <- { name?, status?, identification? }   (solo implementador)
export async function update({ params, body, auth }) {
  requireRole(auth, ['implementador']);
  const current = await getItem(T(), { identification: params.id });
  if (!current) throw notFound('Empresa no encontrada');

  // La identificación es la llave y es editable: si cambia, se recrea el registro.
  const newId = body.identification !== undefined ? str(body.identification, 'identification') : params.id;
  const patch = {
    name: body.name !== undefined ? str(body.name, 'name') : undefined,
    status: body.status !== undefined ? oneOf(body.status, STATUSES, 'status') : undefined,
    updated_at: nowIso()
  };

  if (newId !== params.id) {
    const clash = await getItem(T(), { identification: newId });
    if (clash) throw conflict('Ya existe una empresa con esa identificación');
    const moved = { ...current, ...clean(patch), identification: newId };
    await putItem(T(), moved);
    await deleteItem(T(), { identification: params.id });
    return toDto(moved);
  }

  const updated = await updateItem(T(), { identification: params.id }, patch);
  return toDto(updated);
}

// DELETE /companies/{identification}   (solo implementador)
export async function remove({ params, auth }) {
  requireRole(auth, ['implementador']);
  try {
    await deleteItem(T(), { identification: params.id });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw notFound('Empresa no encontrada');
    throw e;
  }
  return null;
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
