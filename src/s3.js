import { config } from './config.js';
import { conflict } from './errors.js';

let s3ClientPromise;
async function getS3() {
  if (!s3ClientPromise) {
    s3ClientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => new S3Client({ region: config.region }));
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
  const region = config.region;

  if (!config.s3.provisioningEnabled) {
    console.log(`[s3] S3_PROVISIONING_ENABLED=false -> no se toca AWS. bucket=${bucket}`);
    return { created: false, bucket, region, prefixCreated: false, skipped: true };
  }

  const s3 = await getS3();
  const {
    HeadBucketCommand,
    CreateBucketCommand,
    PutPublicAccessBlockCommand,
    PutObjectCommand
  } = await import('@aws-sdk/client-s3');

  let created = false;
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`[s3] bucket ya existe y es accesible. bucket=${bucket} region=${region}`);
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode;
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
        console.error(`[s3] ERROR creando bucket. bucket=${bucket} region=${region} name=${createErr.name} message=${createErr.message}`);
        if (createErr.name === 'BucketAlreadyExists') {
          throw conflict(`El bucket "${bucket}" ya existe en otra cuenta de AWS (los nombres de bucket son globales). Elige otro nombre.`);
        }
        throw createErr;
      }
    } else if (status === 403 || e.name === 'Forbidden') {
      console.error(`[s3] ERROR: bucket ${bucket} existe pero pertenece a otra cuenta o sin permisos.`);
      throw conflict(`El bucket "${bucket}" existe pero no pertenece a esta cuenta de AWS (o falta permiso). Elige otro nombre.`);
    } else {
      console.error(`[s3] ERROR inesperado verificando bucket. bucket=${bucket} name=${e.name} message=${e.message}`);
      throw e;
    }
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
