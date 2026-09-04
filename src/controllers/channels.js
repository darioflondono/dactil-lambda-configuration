import { TABLES, getItem, putItem, updateItem, deleteItem, scanAll } from '../db.js';
import { notFound } from '../errors.js';
import { ensureBucket } from '../s3.js';
import { nowIso, oneOf, str, toArray, toInt, uuid } from '../util.js';

const T = () => TABLES.channels;
const TYPES = ['s3', 'bd', 'mail'];
const STATUSES = ['active', 'inactive'];
const PROVIDERS = ['openai', 'claude'];

function normalizeConfig(type, raw = {}) {
  if (type === 's3') {
    return {
      bucket: str(raw.bucket, 'config.bucket'),
      user: (raw.user ?? '').toString(),
      prefix: (raw.prefix ?? '').toString(),
      extensions: toArray(raw.extensions),
      recursive: raw.recursive !== false,
      max_files: toInt(raw.max_files, 100)
    };
  }
  if (type === 'bd') {
    return {
      host: str(raw.host, 'config.host'),
      port: toInt(raw.port, 5432),
      user: (raw.user ?? '').toString(),
      password: (raw.password ?? '').toString(),
      tables: toArray(raw.tables)
    };
  }
  // mail
  return {
    host: str(raw.host, 'config.host'),
    port: toInt(raw.port, 993),
    user: (raw.user ?? '').toString(),
    password: (raw.password ?? '').toString()
  };
}

function toDto(item) {
  if (!item) return null;
  return {
    id: item.id,
    user_id: item.user_id,
    type: item.type,
    status: item.status,
    provider: item.provider,
    model: item.model,
    config: item.config ?? {},
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

// GET /channels/
export async function list() {
  const items = await scanAll(T());
  return items.map(toDto).sort((a, b) => (a.user_id || '').localeCompare(b.user_id || ''));
}

// GET /channels/{id}
export async function get({ params }) {
  const item = await getItem(T(), { id: params.id });
  if (!item) throw notFound('Canal no encontrado');
  return toDto(item);
}

// POST /channels/   <- Channel (sin id; se genera)
export async function create({ body }) {
  const user_id = str(body.user_id, 'user_id');
  const type = oneOf(body.type, TYPES, 'type');
  const status = oneOf(body.status ?? 'active', STATUSES, 'status');
  const provider = oneOf(body.provider, PROVIDERS, 'provider');
  const model = str(body.model, 'model');
  const cfg = normalizeConfig(type, body.config);

  // Canal S3: provisiona de verdad el bucket en AWS antes de guardar el canal,
  // para que al entrar a la consola de S3 ya esté configurado.
  let bucketStatus;
  if (type === 's3') {
    bucketStatus = await ensureBucket({ bucket: cfg.bucket, prefix: cfg.prefix });
  }

  const ts = nowIso();
  const item = {
    id: uuid(),
    user_id,
    type,
    status,
    provider,
    model,
    config: cfg,
    created_at: ts,
    updated_at: ts
  };
  await putItem(T(), item);
  console.log(`[channels.create] canal=${item.id} type=${type}` + (bucketStatus ? ` bucket=${bucketStatus.bucket} bucket_creado=${bucketStatus.created}` : ''));

  return { ...toDto(item), bucket_status: bucketStatus ?? null };
}

// PUT /channels/{id}   <- Channel parcial
export async function update({ params, body }) {
  const current = await getItem(T(), { id: params.id });
  if (!current) throw notFound('Canal no encontrado');

  const type = body.type !== undefined ? oneOf(body.type, TYPES, 'type') : current.type;
  const patch = { updated_at: nowIso() };
  if (body.user_id !== undefined) patch.user_id = str(body.user_id, 'user_id');
  if (body.type !== undefined) patch.type = type;
  if (body.status !== undefined) patch.status = oneOf(body.status, STATUSES, 'status');
  if (body.provider !== undefined) patch.provider = oneOf(body.provider, PROVIDERS, 'provider');
  if (body.model !== undefined) patch.model = str(body.model, 'model');
  let bucketStatus;
  if (body.config !== undefined || body.type !== undefined) {
    patch.config = normalizeConfig(type, body.config ?? current.config);
    if (type === 's3') {
      bucketStatus = await ensureBucket({ bucket: patch.config.bucket, prefix: patch.config.prefix });
    }
  }

  const updated = await updateItem(T(), { id: params.id }, patch);
  console.log(`[channels.update] canal=${params.id} type=${type}` + (bucketStatus ? ` bucket=${bucketStatus.bucket} bucket_creado=${bucketStatus.created}` : ''));

  return { ...toDto(updated), bucket_status: bucketStatus ?? null };
}

// DELETE /channels/{id}
export async function remove({ params }) {
  try {
    await deleteItem(T(), { id: params.id });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw notFound('Canal no encontrado');
    throw e;
  }
  return null;
}
