// Where document files live, and how they are encrypted.
//
// DOCUMENT_STORAGE=database (default): the file bytes stay in the database row, as before.
// DOCUMENT_STORAGE=r2: the bytes go to a Cloudflare R2 bucket (S3 API); the row keeps only a storage key.
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (R2_ENDPOINT overrides the URL, for tests).
// DOCUMENT_ENCRYPTION_KEY (32 bytes, base64 or 64 hex characters): every new file is encrypted with
//   AES-256-GCM before it is stored, in the bucket and in the database alike. Files saved before the key
//   was set stay readable (they have no "VEY1" header). Losing the key means losing the files: keep a copy.
const crypto = require('node:crypto');

const MAGIC = Buffer.from('VEY1');

function readKey(value = process.env.DOCUMENT_ENCRYPTION_KEY) {
  const text = String(value || '').trim();
  if (!text) return null;
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('DOCUMENT_ENCRYPTION_KEY must be 32 bytes (base64 or 64 hex characters).');
  return key;
}

function isSealed(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 32 && buffer.subarray(0, 4).equals(MAGIC);
}

// Encrypts when a key is set; otherwise returns the bytes as they are.
function seal(content, key = readKey()) {
  const plain = Buffer.from(content);
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function open(content, key = readKey()) {
  const buffer = Buffer.from(content || []);
  if (!isSealed(buffer)) return buffer;
  if (!key) throw new Error('This file is encrypted and DOCUMENT_ENCRYPTION_KEY is not set.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(4, 16));
  decipher.setAuthTag(buffer.subarray(16, 32));
  return Buffer.concat([decipher.update(buffer.subarray(32)), decipher.final()]);
}

/* ---------- S3 / R2 (AWS Signature Version 4, no SDK) ---------- */

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const encodePath = (key) => key.split('/').map((part) => encodeURIComponent(part)).join('/');

// Returns the headers for one signed request (exported for the test against AWS's published example).
function signRequest({ method, url, headers = {}, body = Buffer.alloc(0), accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date(), payloadHash }) {
  const target = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const hash = payloadHash || sha256Hex(body);
  const all = { ...headers, host: target.host, 'x-amz-content-sha256': hash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const query = [...target.searchParams.entries()]
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [method, target.pathname, query, names.map((name) => `${name}:${lower[name]}\n`).join(''), names.join(';'), hash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`
  };
}

function r2Config(env = process.env) {
  const config = {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT
  };
  const missing = ['accessKeyId', 'secretAccessKey', 'bucket'].filter((name) => !config[name]);
  if (!config.endpoint && !config.accountId) missing.push('accountId');
  if (missing.length) {
    const names = { accountId: 'R2_ACCOUNT_ID', accessKeyId: 'R2_ACCESS_KEY_ID', secretAccessKey: 'R2_SECRET_ACCESS_KEY', bucket: 'R2_BUCKET' };
    throw new Error(`DOCUMENT_STORAGE=r2 needs ${missing.map((name) => names[name]).join(', ')}.`);
  }
  config.endpoint = (config.endpoint || `https://${config.accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  return config;
}

function createR2Store(config = r2Config()) {
  async function request(method, key, body) {
    const url = `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodePath(key)}`;
    const payload = body || Buffer.alloc(0);
    const headers = signRequest({
      method, url, body: payload, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
      headers: body ? { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) } : {}
    });
    delete headers.host;
    const response = await fetch(url, { method, headers, body: body ? payload : undefined });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(`Document storage ${method} failed (${response.status}).`);
    }
    return method === 'GET' ? Buffer.from(await response.arrayBuffer()) : true;
  }
  return {
    kind: 'r2',
    put: (key, content) => request('PUT', key, content),
    get: (key) => request('GET', key),
    remove: (key) => request('DELETE', key)
  };
}

let store;
function getStore() {
  if (store !== undefined) return store;
  const kind = String(process.env.DOCUMENT_STORAGE || 'database').trim().toLowerCase();
  if (kind === 'database' || kind === '') store = null;
  else if (kind === 'r2' || kind === 's3') store = createR2Store();
  else throw new Error(`DOCUMENT_STORAGE must be "database" or "r2", not "${kind}".`);
  return store;
}

// Checked at start-up so a wrong setting stops the server instead of failing on the first upload.
function checkConfig() {
  readKey();
  const active = getStore();
  return { storage: active ? active.kind : 'database', encrypted: Boolean(readKey()) };
}

function resetForTests() {
  store = undefined;
}

// Each file has one place in the bucket: company / load / content hash, so saving twice overwrites itself.
const documentKey = (tenantId, shipmentId, sha256) => `documents/t${tenantId}/s${shipmentId}/${sha256}`;

module.exports = { checkConfig, createR2Store, documentKey, getStore, isSealed, open, r2Config, readKey, resetForTests, seal, signRequest };
