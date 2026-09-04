/**
 * Servidor HTTP local que envuelve el handler de la Lambda.
 * Útil para desarrollo: el portal apunta a  http://localhost:8000/api/v1
 *
 *   node scripts/local-server.js         (usa DynamoDB según .env: real o DDB_ENDPOINT)
 */
import { createServer } from 'node:http';
import { handler } from '../src/handler.js';

const PORT = process.env.PORT || 8000;

createServer(async (httpReq, httpRes) => {
  const chunks = [];
  for await (const c of httpReq) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');

  const event = {
    version: '2.0',
    rawPath: httpReq.url,
    requestContext: { http: { method: httpReq.method, path: httpReq.url } },
    headers: httpReq.headers,
    body: body || undefined,
    isBase64Encoded: false
  };

  try {
    const res = await handler(event);
    httpRes.writeHead(res.statusCode, res.headers || {});
    httpRes.end(res.body || '');
    console.log(`${httpReq.method} ${httpReq.url} -> ${res.statusCode}`);
  } catch (e) {
    httpRes.writeHead(500, { 'Content-Type': 'application/json' });
    httpRes.end(JSON.stringify({ success: false, message: String(e) }));
    console.error(e);
  }
}).listen(PORT, () => console.log(`dactil-lambda-configuration (local) escuchando en http://localhost:${PORT}/api/v1`));
