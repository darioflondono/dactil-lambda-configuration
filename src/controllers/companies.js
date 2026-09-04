import { TABLES, getItem, putItem, updateItem, deleteItem, scanAll } from '../db.js';
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

// GET /companies/
export async function list() {
  const items = await scanAll(T());
  return items.map(toDto).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// GET /companies/{identification}
export async function get({ params }) {
  const item = await getItem(T(), { identification: params.id });
  if (!item) throw notFound('Empresa no encontrada');
  return toDto(item);
}

// POST /companies/   <- { identification, name, status }
export async function create({ body }) {
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

// PUT /companies/{identification}   <- { name?, status?, identification? }
export async function update({ params, body }) {
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

// DELETE /companies/{identification}
export async function remove({ params }) {
  try {
    await deleteItem(T(), { identification: params.id });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw notFound('Empresa no encontrada');
    throw e;
  }
  return null;
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
