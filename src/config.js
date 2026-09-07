import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Carga un .env sencillo (KEY=VALUE por línea) SIN sobreescribir lo que ya
// exista en process.env (las variables de entorno de la función Lambda ganan).
function loadDotEnv() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const raw = readFileSync(join(root, '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* sin .env: se usan solo las env vars */
  }
}
loadDotEnv();

const bool = (v, d = false) => (v == null ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

export const config = {
  region: process.env.AWS_REGION || 'us-east-1',
  ddb: {
    endpoint: process.env.DDB_ENDPOINT || undefined,
    tables: {
      companies: process.env.DDB_TABLE_COMPANIES || 'dactil-companies',
      users: process.env.DDB_TABLE_USERS || 'dactil-users',
      channels: process.env.DDB_TABLE_CHANNELS || 'dactil-channels'
    }
  },
  auth: {
    required: bool(process.env.REQUIRE_AUTH, false),
    jwtSecret: process.env.JWT_SECRET || ''
  },
  passwordPepper: process.env.PASSWORD_PEPPER || '',
  s3: {
    // true (default): al crear/editar un canal tipo "s3" se crea de verdad el bucket
    // en AWS (si no existe). false: solo se guarda la configuración (útil en dev sin
    // credenciales AWS o en tests).
    provisioningEnabled: bool(process.env.S3_PROVISIONING_ENABLED, true),
    // Región del bucket de documentos / Knowledge Base (S3 Vectors). Puede ser
    // DISTINTA de `region` (que es la de DynamoDB/la propia Lambda): es us-east-2
    // porque la cuota on-demand de embeddings de Bedrock está en 0 en us-east-1 y
    // us-west-2 para esta cuenta y no es ajustable (ver dactil-lambda-chat/src/config.py).
    region: process.env.S3_REGION || 'us-east-2'
  },
  email: {
    enabled: bool(process.env.EMAIL_ENABLED, false),
    sesRegion: process.env.SES_REGION || process.env.AWS_REGION || 'us-east-1',
    from: process.env.EMAIL_FROM || 'no-reply@dactil.example',
    fromName: process.env.EMAIL_FROM_NAME || 'Dáctil',
    portalBaseUrl: (process.env.PORTAL_BASE_URL || 'http://localhost:4200').replace(/\/+$/, '')
  },
  corsOrigin: process.env.CORS_ORIGIN || '*'
};
