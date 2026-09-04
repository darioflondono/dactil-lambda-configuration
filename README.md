# dactil-lambda-configuration

Lambda **Node.js 20** (sin frameworks) que expone el CRUD de **companies / users / channels**
sobre **DynamoDB**, más `POST /auth/set-password` y el correo de bienvenida (SES v2).
Es el backend del portal `dactil-llm-chat-portal` (secciones *Gestión de Empresas / Usuarios / Canales*).

## Contratos

Prefijo: `/api/v1` (la Lambda también acepta las rutas sin el prefijo).

| Método | Ruta | Cuerpo / Notas |
|---|---|---|
| GET  | `/companies/` | `[{ identification, name, status, ... }]` |
| POST | `/companies/` | `{ identification, name, status }` → 201 |
| GET  | `/companies/{identification}` | |
| PUT  | `/companies/{identification}` | `{ name?, status?, identification? }` |
| DEL  | `/companies/{identification}` | 204 |
| GET  | `/users/` | `[{ identification, name, email, role, company_id, is_active, ... }]` |
| POST | `/users/` | `{ identification, name, email, role, company_id, is_active? }` — genera contraseña temporal, la hashea (scrypt) y manda el correo. Devuelve `{ ..., email_sent, activation_link }`. 201 |
| GET  | `/users/{identification}` | para la 🔍 lupa del portal |
| PUT  | `/users/{identification}` | `{ name?, email?, role?, company_id?, is_active? }` — **sin** `password` |
| DEL  | `/users/{identification}` | 204 |
| POST | `/auth/set-password` | `{ email, temp_password, new_password }` — valida la temporal y fija la definitiva |
| GET  | `/channels/` | `[{ id, user_id, type, status, provider, model, config, ... }]` |
| POST | `/channels/` | `{ user_id, type, status, provider, model, config }` → 201. Si `type=s3`, **crea el bucket real en AWS** (ver abajo); devuelve además `bucket_status` |
| GET/PUT/DEL | `/channels/{id}` | PUT también reaprovisiona el bucket si `type=s3` |

`type` ∈ `s3` \| `bd` \| `mail`; `status` ∈ `active` \| `inactive`; `provider` ∈ `openai` \| `claude`;
`role` ∈ `implementador` \| `administrador` \| `invitado`.

`config` por tipo:
- **s3**: `{ bucket, user, prefix, extensions[], recursive, max_files }`
- **bd**: `{ host, port, user, password, tables[] }`
- **mail**: `{ host, port, user, password }`

Respuestas: `{ "success": true, "data": ... }` / `{ "success": false, "message": "...", "error": "CODE" }`.

## Estructura

```
src/
  handler.js       punto de entrada Lambda (API GW v1/v2 + invocación directa)
  router.js        tabla de rutas -> controlador
  config.js        carga .env
  db.js            DynamoDB DocumentClient + helpers (get/put/update/delete/scan)
  auth.js          hash scrypt, contraseña temporal, JWT HS256 opcional
  email.js         correo de bienvenida (SES v2; no-op si EMAIL_ENABLED=false)
  s3.js            aprovisiona el bucket real de un canal s3 (no-op si S3_PROVISIONING_ENABLED=false)
  responses.js     envelope + CORS
  errors.js        ApiError + helpers (badRequest, notFound, conflict, ...)
  util.js          validadores
  controllers/     companies.js · users.js · channels.js
scripts/local-server.js      servidor HTTP local (puerto 8000)
scripts/send-test-email.js   envía un correo de prueba por SES (npm run send-test-email)
tests/api.test.js            suite con DynamoDB en memoria  (npm test)
deploy/                      scripts de despliegue (abajo)
events/                      eventos de ejemplo para `aws lambda invoke`
```

## Configuración (`.env`)

Copia `.env.example` a `.env`. Se empaqueta en el zip y se carga al arrancar
(o define las mismas claves como variables de entorno de la función).

| Clave | Default | Para qué |
|---|---|---|
| `AWS_REGION` | `us-east-1` | región |
| `DDB_ENDPOINT` | *(vacío)* | vacío = DynamoDB real; `http://localhost:8000` = DynamoDB Local |
| `DDB_TABLE_COMPANIES` / `_USERS` / `_CHANNELS` | `dactil-companies` / `dactil-users` / `dactil-channels` | nombres de tabla |
| `REQUIRE_AUTH` | `false` | `true` exige `Authorization: Bearer <jwt HS256>` |
| `JWT_SECRET` | | secreto para validar el JWT |
| `PASSWORD_PEPPER` | | pimienta opcional del hash scrypt |
| `EMAIL_ENABLED` | `true` | `true` envía el correo de bienvenida por SES; `false` solo loguea el enlace |
| `SES_REGION` / `EMAIL_FROM` / `EMAIL_FROM_NAME` | `us-east-1` / `gestion.dactil@gmail.com` / `Dactil` | remitente verificado en SES (`deploy/setup-ses.sh`) |
| `PORTAL_BASE_URL` | `http://localhost:4200` | base del enlace `/activar?email=...` |
| `S3_PROVISIONING_ENABLED` | `true` | `true` crea/verifica el bucket real en S3 al guardar un canal `s3`; `false` solo guarda la config |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` |

> El `.env` solo lleva **configuración no secreta** (nombres, flags). En Lambda las
> credenciales AWS vienen del rol de ejecución.

## Desarrollo local

```bash
npm install
npm test                 # suite con DynamoDB en memoria (no toca AWS)
npm run local            # servidor en http://localhost:8000
# en otra terminal:
curl -s http://localhost:8000/api/v1/companies/
```

Para pegar a una DynamoDB Local real: `docker run -p 8000:8000 amazon/dynamodb-local`
y pon `DDB_ENDPOINT=http://localhost:8000` en `.env` (más `AWS_ACCESS_KEY_ID`/`SECRET` dummy).

## Despliegue

Requisitos: **AWS CLI v2** autenticada (`aws sso login --profile <perfil>` o variables de
entorno), **Node 20 + npm**.

### Todo en un comando

Windows (PowerShell):
```powershell
.\deploy\deploy-all.ps1 -AwsProfile dactil -Region us-east-1
```

Linux / macOS / git-bash:
```bash
AWS_PROFILE=dactil REGION=us-east-1 ./deploy/deploy-all.sh
```

Hace, de forma idempotente: **DynamoDB** (3 tablas on-demand) → **SES** (verifica el
remitente) → **build** `dist/function.zip` → **IAM** rol + política → **Lambda**
create/update (`nodejs20.x`, handler `src/handler.handler`) → **API Gateway** HTTP API
con proxy `ANY /{proxy+}` → **smoke test**.

### Paso a paso

```bash
./deploy/setup-dynamodb.sh      # crea dactil-companies / dactil-users / dactil-channels
./deploy/setup-ses.sh           # verifica EMAIL_FROM en SES (gestion.dactil@gmail.com)
./deploy/build.sh               # -> dist/function.zip   (o  deploy\build.ps1  en Windows)
./deploy/setup-iam.sh           # rol dactil-lambda-configuration-role + iam-policy.json
./deploy/deploy.sh              # crea/actualiza la función
./deploy/setup-apigateway.sh    # imprime el ApiEndpoint
```

### Probar

```bash
# vía API Gateway
curl -s https://XXXX.execute-api.us-east-1.amazonaws.com/api/v1/companies/

# invocación directa
aws lambda invoke --function-name dactil-lambda-configuration \
  --payload fileb://events/create-company.json --cli-binary-format raw-in-base64-out out.json
cat out.json
```

## Correo de bienvenida (SES)

En el alta de usuario (`POST /users/`) se envía el correo con la contraseña temporal
y el enlace `/activar?email=...` mediante **Amazon SES v2** (`src/email.js`).

**Puesta a punto:**

1. `./deploy/setup-ses.sh` — registra y pide verificación de `EMAIL_FROM`
   (`gestion.dactil@gmail.com`). Abre el correo que manda AWS y confirma el enlace.
2. Si la cuenta SES está en **sandbox** (por defecto), también hay que verificar cada
   destinatario: `VERIFY_RECIPIENTS="correo@dominio.com" ./deploy/setup-ses.sh`.
   Para enviar a cualquiera, pide *production access* en la consola de SES.
3. `.env`: `EMAIL_ENABLED=true`, `EMAIL_FROM=gestion.dactil@gmail.com`, `SES_REGION=us-east-1`.
4. El rol de la Lambda ya trae `ses:SendEmail` (`deploy/iam-policy.json`).

**Probar el envío** (local, sin crear usuario):

```bash
AWS_PROFILE=dactil npm run send-test-email -- destinatario@dominio.com "Nombre Apellido"
```

**Validar en CloudWatch** — cada alta deja estas trazas en el log group
`/aws/lambda/dactil-lambda-configuration`:

```
[email] OK correo de bienvenida ENVIADO por SES. to=... from=gestion.dactil@gmail.com region=us-east-1 messageId=010f0193... ms=412
[users.create] usuario=1020304050 email=ana@acme.com correo_enviado=true messageId=010f0193...
```

Si falla:

```
[email] ERROR SES al enviar correo de bienvenida. to=... name=MessageRejected message=Email address is not verified... 
[users.create] usuario=... correo_enviado=false motivo=MessageRejected error="Email address is not verified..."
```

La respuesta HTTP del alta incluye `email_sent`, `email_message_id` y `activation_link`.
El envío **nunca** tumba el alta: si SES rechaza, el usuario queda creado igual.

Consultar los logs por CLI:

```bash
aws logs tail /aws/lambda/dactil-lambda-configuration --region us-east-1 --follow --filter-pattern '"[email]"'
```

## Aprovisionamiento de canales S3

Al crear (o editar) un canal con `type: "s3"`, `POST/PUT /channels/` **no solo guarda la
configuración**: `src/s3.js → ensureBucket()` llama a S3 de verdad para que el bucket
quede visible en la consola de AWS al terminar el flujo:

1. `HeadBucket` — si el bucket ya existe y es de la cuenta, lo deja tal cual.
2. Si no existe, `CreateBucket` (con `LocationConstraint` salvo en `us-east-1`) y le aplica
   `PutPublicAccessBlock` (bloquea todo acceso público).
3. Si se dio `prefix` (ej. `facturas/`), sube un objeto vacío `prefix/` para que la
   "carpeta" aparezca de inmediato en el explorador de la consola S3.
4. Si el nombre de bucket ya existe **en otra cuenta de AWS** (los nombres son globales),
   responde `409 Conflict` con un mensaje claro en vez de guardar el canal.

La respuesta de `create`/`update` incluye `bucket_status: { created, bucket, region, prefixCreated }`
(el portal lo muestra en el mensaje de éxito). Trazas en CloudWatch:

```
[s3] bucket no existe, creando. bucket=dactil-bucket-de-documentos region=us-east-1
[s3] OK bucket CREADO. bucket=dactil-bucket-de-documentos region=us-east-1
[s3] OK carpeta/prefijo lista en el bucket. bucket=dactil-bucket-de-documentos key=facturas/
[channels.create] canal=... type=s3 bucket=dactil-bucket-de-documentos bucket_creado=true
```

Para desactivarlo (dev sin credenciales AWS, o tests): `S3_PROVISIONING_ENABLED=false` en `.env`.
El rol de la Lambda ya trae los permisos necesarios (`deploy/iam-policy.json`,
sección `ProvisionChannelS3Buckets`).

## Notas

- Tablas pequeñas → los listados usan `Scan`. Para escalar la búsqueda de usuario por
  correo (`set-password`), crea el GSI `by-email` (comando comentado en
  `deploy/setup-dynamodb.sh`) y cambia `findByEmail()` en `src/controllers/users.js` por un `Query`.
- `toDto()` de users **nunca** expone `password_hash`.
