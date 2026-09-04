import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// El correo y el aprovisionamiento de S3 se prueban aparte; aquí los forzamos OFF
// para no llamar a SES/S3 reales.
process.env.EMAIL_ENABLED = 'false';
process.env.S3_PROVISIONING_ENABLED = 'false';

// --- DynamoDB en memoria (reemplaza doc.send antes de importar el handler) ---
const { doc } = await import('../src/db.js');
const tables = new Map(); // TableName -> Map(pkStr -> item)

const tbl = (n) => {
  if (!tables.has(n)) tables.set(n, new Map());
  return tables.get(n);
};
const pkStr = (key) => {
  const [k, v] = Object.entries(key)[0];
  return `${k}=${v}`;
};

doc.send = async (cmd) => {
  const name = cmd.constructor.name;
  const p = cmd.input;
  const t = tbl(p.TableName);

  if (name === 'GetCommand') return { Item: t.get(pkStr(p.Key)) };

  if (name === 'PutCommand') {
    if (p.ConditionExpression?.includes('attribute_not_exists') && t.has(pkStr(itemKey(p.Item)))) {
      throw named('ConditionalCheckFailedException');
    }
    t.set(pkStr(itemKey(p.Item)), { ...p.Item });
    return {};
  }

  if (name === 'UpdateCommand') {
    const cur = t.get(pkStr(p.Key));
    if (p.ConditionExpression?.includes('attribute_exists') && !cur) throw named('ConditionalCheckFailedException');
    const item = { ...(cur || {}), ...p.Key };
    for (const part of p.UpdateExpression.replace(/^SET\s+/i, '').split(',')) {
      const [lhs, rhs] = part.split('=').map((s) => s.trim());
      item[p.ExpressionAttributeNames[lhs]] = p.ExpressionAttributeValues[rhs];
    }
    t.set(pkStr(p.Key), item);
    return { Attributes: item };
  }

  if (name === 'DeleteCommand') {
    if (p.ConditionExpression?.includes('attribute_exists') && !t.has(pkStr(p.Key))) {
      throw named('ConditionalCheckFailedException');
    }
    t.delete(pkStr(p.Key));
    return {};
  }

  if (name === 'ScanCommand') {
    let items = [...t.values()];
    if (p.FilterExpression) {
      const m = p.FilterExpression.match(/#(\w+)\s*=\s*:(\w+)/);
      const field = p.ExpressionAttributeNames['#' + m[1]];
      const val = p.ExpressionAttributeValues[':' + m[2]];
      items = items.filter((it) => it[field] === val);
    }
    return { Items: items };
  }
  throw new Error('comando no soportado en el fake: ' + name);
};

function itemKey(item) {
  // asume PK simple: usa 'identification' o 'id'
  if (item.identification !== undefined) return { identification: item.identification };
  return { id: item.id };
}
function named(n) {
  const e = new Error(n);
  e.name = n;
  return e;
}

let handler;
before(async () => {
  ({ handler } = await import('../src/handler.js'));
});

const call = (method, path, body) =>
  handler({
    version: '2.0',
    rawPath: '/api/v1' + path,
    requestContext: { http: { method } },
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
const json = (res) => JSON.parse(res.body);

test('companies CRUD', async () => {
  let r = await call('POST', '/companies/', { identification: '80001', name: 'ACME', status: 'active' });
  assert.equal(r.statusCode, 201);
  assert.equal(json(r).data.name, 'ACME');

  r = await call('POST', '/companies/', { identification: '80001', name: 'Dup' });
  assert.equal(r.statusCode, 409);

  r = await call('GET', '/companies/');
  assert.equal(json(r).data.length, 1);

  r = await call('PUT', '/companies/80001', { status: 'inactive' });
  assert.equal(json(r).data.status, 'inactive');

  r = await call('GET', '/companies/80001');
  assert.equal(json(r).data.status, 'inactive');

  r = await call('DELETE', '/companies/80001');
  assert.equal(r.statusCode, 200);
  r = await call('GET', '/companies/80001');
  assert.equal(r.statusCode, 404);
});

test('users: create hashea, GET no expone hash, set-password funciona', async () => {
  let r = await call('POST', '/users/', {
    identification: '1130',
    name: 'Ana Pérez',
    email: 'ana@empresa.com',
    password: 'Temp12345',
    role: 'administrador',
    company_id: '80001'
  });
  assert.equal(r.statusCode, 201);
  const dto = json(r).data;
  assert.equal(dto.email, 'ana@empresa.com');
  assert.equal(dto.must_change_password, true);
  assert.equal(dto.password_hash, undefined);
  assert.equal(dto.email_sent, false); // EMAIL_ENABLED=false

  // rol inválido
  r = await call('POST', '/users/', { identification: 'x', name: 'x', email: 'x@y.com', password: 'p', role: 'root', company_id: '1' });
  assert.equal(r.statusCode, 400);

  // lupa
  r = await call('GET', '/users/1130');
  assert.equal(json(r).data.name, 'Ana Pérez');

  // PUT sin password
  r = await call('PUT', '/users/1130', { password: 'x' });
  assert.equal(r.statusCode, 400);
  r = await call('PUT', '/users/1130', { role: 'invitado' });
  assert.equal(json(r).data.role, 'invitado');

  // set-password: temporal incorrecta
  r = await call('POST', '/auth/set-password', { email: 'ana@empresa.com', temp_password: 'mala', new_password: 'NuevaClave1' });
  assert.equal(r.statusCode, 401);

  // set-password OK
  r = await call('POST', '/auth/set-password', { email: 'ana@empresa.com', temp_password: 'Temp12345', new_password: 'NuevaClave1' });
  assert.equal(r.statusCode, 200);

  // la temporal ya no sirve
  r = await call('POST', '/auth/set-password', { email: 'ana@empresa.com', temp_password: 'Temp12345', new_password: 'Otra12345' });
  assert.equal(r.statusCode, 401);
});

test('channels CRUD con config por tipo', async () => {
  let r = await call('POST', '/channels/', {
    user_id: '1130',
    type: 's3',
    status: 'active',
    provider: 'openai',
    model: 'gpt-4o-mini',
    config: { bucket: 'mi-bucket', prefix: 'facturas/', extensions: '.xml, .pdf', recursive: true, max_files: 50 }
  });
  assert.equal(r.statusCode, 201);
  const ch = json(r).data;
  assert.equal(ch.type, 's3');
  assert.deepEqual(ch.config.extensions, ['.xml', '.pdf']);
  assert.ok(ch.id);

  r = await call('GET', `/channels/${ch.id}`);
  assert.equal(json(r).data.config.bucket, 'mi-bucket');

  r = await call('PUT', `/channels/${ch.id}`, { type: 'bd', config: { host: 'db', port: 5432, user: 'ro', password: 'x', tables: 'a,b' } });
  assert.equal(json(r).data.type, 'bd');
  assert.deepEqual(json(r).data.config.tables, ['a', 'b']);

  r = await call('DELETE', `/channels/${ch.id}`);
  assert.equal(r.statusCode, 200);
});

test('routing: 404 y 405', async () => {
  assert.equal((await call('GET', '/nope')).statusCode, 404);
  assert.equal((await call('PATCH', '/companies/1')).statusCode, 405);
  assert.equal((await handler({ version: '2.0', rawPath: '/api/v1/companies', requestContext: { http: { method: 'OPTIONS' } } })).statusCode, 204);
});
