import { config } from './config.js';
import { conflict } from './errors.js';

let s3ClientPromise;
async function getS3() {
  if (!s3ClientPromise) {
    s3ClientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({ region: config.s3.region }));
  }
  return s3ClientPromise;
}

/**
 * Garantiza que el bucket S3 de un canal exista de verdad en AWS (lo crea si falta)
 * y, si se dio un prefijo, deja el "folder" visible en la consola (objeto marcador
 * con Key terminada en "/"). Idempotente: si el bucket ya existe y es nuestro, no
 * hace nada más que verificarlo.
 *
 * @returns {Promise<{created:boolean, bucket:string, region:string, prefixCreated:boolean}>}
 */
export async function ensureBucket({ bucket, prefix }) {
  const region = config.s3.region;

  if (!config.s3.provisioningEnabled) {
    console.log(`[s3] S3_PROVISIONING_ENABLED=false -> no se toca AWS. bucket=${bucket}`);
    return { created: false, bucket, region, prefixCreated: false, skipped: true };
  }

  const s3 = await getS3();
  const {
    HeadBucketCommand,
    CreateBucketCommand,
    PutPublicAccessBlockCommand,
    PutBucketCorsCommand,
    PutObjectCommand
  } = await import('@aws-sdk/client-s3');

  let created = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`[s3] bucket ya existe y es accesible. bucket=${bucket} region=${region}`);
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode;
    console.log(
      `[s3] HeadBucket respondio con error. bucket=${bucket} region=${region} status=${status} respuesta=${JSON.stringify(
        e,
        Object.getOwnPropertyNames(e)
      )}`
    );
    if (status === 404 || e.name === 'NotFound' || e.name === 'NoSuchBucket') {
      console.log(`[s3] bucket no existe, creando. bucket=${bucket} region=${region}`);
      try {
        await s3.send(
          new CreateBucketCommand({
            Bucket: bucket,
            // us-east-1 no admite CreateBucketConfiguration (es la región por defecto).
            ...(region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: region } } : {})
          })
        );
        created = true;
        await s3.send(
          new PutPublicAccessBlockCommand({
            Bucket: bucket,
            PublicAccessBlockConfiguration: {
              BlockPublicAcls: true,
              IgnorePublicAcls: true,
              BlockPublicPolicy: true,
              RestrictPublicBuckets: true
            }
          })
        ).catch((e2) => console.warn(`[s3] no se pudo bloquear acceso público de ${bucket}:`, e2.message));
        console.log(`[s3] OK bucket CREADO. bucket=${bucket} region=${region}`);
      } catch (createErr) {
        console.error(
          `[s3] ERROR creando bucket. bucket=${bucket} region=${region} respuesta=${JSON.stringify(
            createErr,
            Object.getOwnPropertyNames(createErr)
          )}`
        );
        if (createErr.name === 'BucketAlreadyExists') {
          throw conflict(`El bucket "${bucket}" ya existe en otra cuenta de AWS (los nombres de bucket son globales). Elige otro nombre.`);
        }
        throw createErr;
      }
    } else if (status === 403 || e.name === 'Forbidden' || e.name === 'AccessDenied') {
      console.error(
        `[s3] ERROR: HeadBucket denegado para ${bucket} (puede ser bucket de otra cuenta O falta de permiso IAM del rol de la Lambda). respuesta=${JSON.stringify(
          e,
          Object.getOwnPropertyNames(e)
        )}`
      );
      throw conflict(`El bucket "${bucket}" existe pero no pertenece a esta cuenta de AWS (o falta permiso). Elige otro nombre.`);
    } else {
      console.error(
        `[s3] ERROR inesperado verificando bucket. bucket=${bucket} respuesta=${JSON.stringify(e, Object.getOwnPropertyNames(e))}`
      );
      throw e;
    }
  }

  // CORS del bucket: el portal sube los documentos DIRECTO a S3 con una URL prefirmada
  // (PUT desde el navegador), así el archivo no pasa por API Gateway/Lambda (límite 10 MB).
  // Sin esta config el navegador bloquea ese PUT. Idempotente.
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedOrigins: ['*'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3000
            }
          ]
        }
      })
    );
    console.log(`[s3] CORS del bucket configurado (PUT directo desde el navegador). bucket=${bucket}`);
  } catch (e) {
    console.warn(`[s3] no se pudo configurar CORS del bucket. bucket=${bucket} error=${e.message}`);
  }

  let prefixCreated = false;
  const folderKey = (prefix || '').trim();
  if (folderKey) {
    const key = folderKey.endsWith('/') ? folderKey : `${folderKey}/`;
    try {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: '' }));
      prefixCreated = true;
      console.log(`[s3] OK carpeta/prefijo lista en el bucket. bucket=${bucket} key=${key}`);
    } catch (e) {
      // Cosmético: si falla no rompe la creación del canal.
      console.warn(`[s3] no se pudo crear el marcador del prefijo. bucket=${bucket} key=${key} error=${e.message}`);
    }
  }

  return { created, bucket, region, prefixCreated };
}

/** Nombre de archivo seguro para usar como parte de una key de S3. */
function sanitizeFilename(name) {
  const base = String(name || '').split(/[/\\]/).pop() || 'archivo';
  const safe = base.replace(/[^A-Za-z0-9_.\-]/g, '_');
  return safe.slice(-150) || 'archivo';
}

/** Segundos de validez de cada URL prefirmada de subida. */
const PRESIGN_EXPIRES_IN = 900; // 15 min

/**
 * Genera una URL prefirmada (PUT) por archivo para que el navegador suba los documentos
 * DIRECTO a S3, bajo {company_id}/[{prefix}/]{timestamp}-{archivo}. El archivo NO pasa por
 * API Gateway/Lambda, así se evita el límite de 10 MB de payload (ver el 413 que devolvía
 * la subida en base64). Mismo esquema {bucket}/{company} que usa dactil-lambda-chat para
 * sincronizar cada empresa por separado hacia el Knowledge Base (knowledge_base_service.py).
 *
 * `files`: [{ filename, content_type? }].
 *
 * @returns {Promise<Array<{filename:string, key:string, url:string|null, content_type:string, expires_in:number, skipped?:boolean}>>}
 */
export async function presignUploads({ bucket, company_id, prefix, files }) {
  if (!Array.isArray(files) || files.length === 0) return [];

  const folder = (prefix || '').trim().replace(/^\/+|\/+$/g, '');
  const stamp = Date.now();

  const build = (file, i) => {
    const filename = file?.filename || 'archivo';
    const content_type = file?.content_type || 'application/octet-stream';
    const key = [company_id, folder, `${stamp}-${i}-${sanitizeFilename(filename)}`].filter(Boolean).join('/');
    return { filename, content_type, key };
  };

  // En dev/tests (S3_PROVISIONING_ENABLED=false) no se firma nada: se devuelven las keys
  // que se usarían, con url=null, para poder ejercitar el endpoint sin credenciales AWS.
  if (!config.s3.provisioningEnabled) {
    console.log(`[s3] S3_PROVISIONING_ENABLED=false -> URLs prefirmadas omitidas. bucket=${bucket}`);
    return files.map((f, i) => ({ ...build(f, i), url: null, expires_in: PRESIGN_EXPIRES_IN, skipped: true }));
  }

  const s3 = await getS3();
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const results = [];
  for (let i = 0; i < files.length; i++) {
    const { filename, content_type, key } = build(files[i], i);
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: content_type }),
      { expiresIn: PRESIGN_EXPIRES_IN }
    );
    console.log(`[s3] URL prefirmada generada. bucket=${bucket} key=${key}`);
    results.push({ filename, key, url, content_type, expires_in: PRESIGN_EXPIRES_IN });
  }
  return results;
}
