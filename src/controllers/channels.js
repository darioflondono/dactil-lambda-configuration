import { TABLES, getItem, putItem, updateItem, deleteItem, scanAll } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { ensureBucket, presignUploads } from '../s3.js';
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
    company_id: item.company_id,
    type: item.type,
    status: item.status,
    provider: item.provider,
    model: item.model,
    config: item.config ?? {},
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

// GET /channels/   -> implementador ve todos; administrador solo los de su compañía; invitado sin acceso.
export async function list({ auth } = {}) {
  if (auth?.role === 'invitado') throw forbidden();
  const items = await scanAll(T());
  const all = items.map(toDto).sort((a, b) => (a.user_id || '').localeCompare(b.user_id || ''));
  if (!auth || auth.role === 'implementador') return all;
  return all.filter((c) => c.company_id === auth.company_id);
}

// GET /channels/{id}
export async function get({ params, auth }) {
  if (auth?.role === 'invitado') throw forbidden();
  const item = await getItem(T(), { id: params.id });
  if (!item) throw notFound('Canal no encontrado');
  if (auth?.role === 'administrador' && item.company_id !== auth.company_id) {
    throw notFound('Canal no encontrado');
  }
  return toDto(item);
}

// POST /channels/   <- Channel (sin id; se genera)
//   administrador: el canal siempre queda en su propia compañía (se ignora company_id del body).
export async function create({ body, auth }) {
  if (auth?.role === 'invitado') throw forbidden();
  const user_id = str(body.user_id, 'user_id');
  const company_id = auth?.role === 'administrador' ? auth.company_id : str(body.company_id, 'company_id');
  const type = oneOf(body.type, TYPES, 'type');
  const status = oneOf(body.status ?? 'active', STATUSES, 'status');
  const provider = oneOf(body.provider, PROVIDERS, 'provider');
  const model = str(body.model, 'model');
  const cfg = normalizeConfig(type, body.config);

  // Canal S3: provisiona de verdad el bucket en AWS antes de guardar el canal,
  // para que al entrar a la consola de S3 ya esté configurado. Los documentos se
  // suben aparte, directo a S3 con URL prefirmada (POST /channels/{id}/upload-urls).
  let bucketStatus;
  if (type === 's3') {
    bucketStatus = await ensureBucket({ bucket: cfg.bucket, prefix: cfg.prefix });
  }

  const ts = nowIso();
  const item = {
    id: uuid(),
    user_id,
    company_id,
    type,
    status,
    provider,
    model,
    config: cfg,
    created_at: ts,
    updated_at: ts
  };
  await putItem(T(), item);
  console.log(
    `[channels.create] canal=${item.id} type=${type}` +
      (bucketStatus ? ` bucket=${bucketStatus.bucket} bucket_creado=${bucketStatus.created}` : '')
  );

  return { ...toDto(item), bucket_status: bucketStatus ?? null };
}

// PUT /channels/{id}   <- Channel parcial
//   administrador: solo canales de su compañía, y no puede moverlos a otra.
export async function update({ params, body, auth }) {
  if (auth?.role === 'invitado') throw forbidden();
  const current = await getItem(T(), { id: params.id });
  if (!current) throw notFound('Canal no encontrado');
  if (auth?.role === 'administrador') {
    if (current.company_id !== auth.company_id) throw notFound('Canal no encontrado');
    if (body.company_id !== undefined && body.company_id !== auth.company_id) {
      throw forbidden('No puedes mover el canal a otra compañía');
    }
  }

  const type = body.type !== undefined ? oneOf(body.type, TYPES, 'type') : current.type;
  const patch = { updated_at: nowIso() };
  if (body.user_id !== undefined) patch.user_id = str(body.user_id, 'user_id');
  if (body.company_id !== undefined && (!auth || auth.role === 'implementador')) {
    patch.company_id = str(body.company_id, 'company_id');
  }
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
  console.log(
    `[channels.update] canal=${params.id} type=${type}` +
      (bucketStatus ? ` bucket=${bucketStatus.bucket} bucket_creado=${bucketStatus.created}` : '')
  );

  return { ...toDto(updated), bucket_status: bucketStatus ?? null };
}

// POST /channels/{id}/upload-urls   <- { files: [{ filename, content_type? }] }
//   Devuelve una URL prefirmada (PUT) por archivo para subir los documentos DIRECTO a S3,
//   sin pasar por API Gateway/Lambda (evita el límite de 10 MB de payload). El navegador
//   hace `PUT <url>` con el archivo como body y la cabecera Content-Type que se indicó aquí.
const MAX_UPLOAD_FILES = 50;

export async function uploadUrls({ params, body, auth }) {
  if (auth?.role === 'invitado') throw forbidden();
  const channel = await getItem(T(), { id: params.id });
  if (!channel) throw notFound('Canal no encontrado');
  if (auth?.role === 'administrador' && channel.company_id !== auth.company_id) {
    throw notFound('Canal no encontrado');
  }
  if (channel.type !== 's3') throw badRequest('El canal no es de tipo s3');

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) throw badRequest("Se requiere 'files': [{ filename, content_type }]");
  if (files.length > MAX_UPLOAD_FILES) throw badRequest(`Máximo ${MAX_UPLOAD_FILES} archivos por lote`);
  for (const f of files) str(f?.filename, 'files[].filename');

  const bucket = str(channel.config?.bucket, 'config.bucket');
  const prefix = channel.config?.prefix ?? '';

  const bucketStatus = await ensureBucket({ bucket, prefix });
  const uploads = await presignUploads({ bucket, company_id: channel.company_id, prefix, files });

  console.log(`[channels.upload-urls] canal=${params.id} bucket=${bucket} archivos=${uploads.length}`);
  return { bucket, prefix, bucket_status: bucketStatus ?? null, uploads };
}

// DELETE /channels/{id}
export async function remove({ params, auth }) {
  if (auth?.role === 'invitado') throw forbidden();
  if (auth?.role === 'administrador') {
    const current = await getItem(T(), { id: params.id });
    if (!current || current.company_id !== auth.company_id) throw notFound('Canal no encontrado');
  }
  try {
    await deleteItem(T(), { id: params.id });
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw notFound('Canal no encontrado');
    throw e;
  }
  return null;
}
