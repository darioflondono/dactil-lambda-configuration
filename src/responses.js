import { config } from './config.js';

const CORS = {
  'Access-Control-Allow-Origin': config.corsOrigin,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS'
};

export function ok(data, status = 200) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    body: JSON.stringify({ success: true, data: data ?? null }),
    isBase64Encoded: false
  };
}

export function fail(status, message, code) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
    body: JSON.stringify({ success: false, message, error: code || message }),
    isBase64Encoded: false
  };
}

export function noContent() {
  return { statusCode: 204, headers: { ...CORS }, body: '' };
}

export const corsHeaders = CORS;
