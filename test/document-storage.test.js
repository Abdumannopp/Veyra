// Documents in object storage (Cloudflare R2, S3 API) and encrypted at rest.
// A small fake bucket checks every request's signature, so no real R2 account is needed.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const KEY = crypto.randomBytes(32).toString('base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyra-storage-'));
Object.assign(process.env, {
  NODE_ENV: 'development', DATABASE_PATH: path.join(dir, 's.db'), PORT: '0', BCRYPT_COST: '10', API_RATE_LIMIT_MAX: '5000', NEXUS_ENABLED: 'false',
  DOCUMENT_STORAGE: 'database', DOCUMENT_ENCRYPTION_KEY: '',
  R2_ACCESS_KEY_ID: 'test-access', R2_SECRET_ACCESS_KEY: 'test-secret', R2_BUCKET: 'veyra-docs'
});

const blobStore = require('../lib/blob-store');
const database = require('../database');
const { runAsSystem } = require('../lib/tenant-context');
const { app, initialize } = require('../server');
const { db } = database;

// The fake bucket: objects by path; refuses any request whose signature does not match.
const objects = new Map();
let refused = 0;
const bucket = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const signed = Object.fromEntries(['content-type', 'content-length'].filter((name) => req.headers[name] && req.method === 'PUT').map((name) => [name, req.headers[name]]));
    const now = new Date(req.headers['x-amz-date'].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const expected = blobStore.signRequest({
      method: req.method, url: `http://${req.headers.host}${req.url}`, headers: signed, body,
      accessKeyId: 'test-access', secretAccessKey: 'test-secret', now
    });
    if (expected.authorization !== req.headers.authorization) {
      refused += 1;
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'PUT') objects.set(req.url, body);
    if (req.method === 'DELETE') objects.delete(req.url);
    if (req.method === 'GET') {
      if (!objects.has(req.url)) return res.writeHead(404).end();
      return res.writeHead(200).end(objects.get(req.url));
    }
    return res.writeHead(200).end();
  });
});

let server; let base; let admin; let other;
const call = (cookie, method, url, body) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
const upload = (cookie, shipment, bytes, name = 'cmr.pdf') => fetch(`${base}/api/shipments/${shipment}/documents?type=cmr&filename=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/pdf', cookie }, body: bytes });
const pdf = (marker) => Buffer.concat([Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF`), Buffer.alloc(64, 1)]);
const rawRow = (id) => runAsSystem(() => database.sql.get('SELECT content, storage_key AS storageKey FROM documents WHERE id = ?', [id]));
const download = async (cookie, shipment, id) => {
  const res = await call(cookie, 'GET', `/api/shipments/${shipment}/documents/${id}/file`);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
};
function useStorage(kind, key = '') {
  process.env.DOCUMENT_STORAGE = kind;
  process.env.DOCUMENT_ENCRYPTION_KEY = key;
  blobStore.resetForTests();
}
async function login(email, password) {
  const res = await call(null, 'POST', '/api/login', { email, password });
  assert.equal(res.status, 200, email);
  return res.headers.get('set-cookie').split(';')[0];
}
const numeric = (id) => Number(String(id).replace(/\D/g, ''));
async function newLoad(cookie = admin) {
  const res = await call(cookie, 'POST', '/api/shipments', { customer: 'Navoiy Textile', origin: 'Tashkent', destination: 'Almaty', pickup: '2026-12-10', delivery: '2026-12-12', weight: 18000, equipment: 'Reefer' });
  return (await res.json()).shipment.id;
}

before(async () => {
  bucket.listen(0);
  await new Promise((resolve) => bucket.once('listening', resolve));
  process.env.R2_ENDPOINT = `http://127.0.0.1:${bucket.address().port}`;
  await initialize();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin@veyra.ai', 'admin123');
  await call(admin, 'POST', '/api/platform/tenants', { companyName: 'Other Freight', adminName: 'Olga', adminEmail: 'olga@store.example', adminPassword: 'OtherPass2026' });
  other = await login('olga@store.example', 'OtherPass2026');
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => bucket.close(resolve));
  await new Promise((resolve) => db.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('request signing matches the example AWS publishes for Signature Version 4', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (GET Object example)
  const headers = blobStore.signRequest({
    method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' },
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z')
  });
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('encryption: sealed files open with the key only; old plain files still open; bad settings are refused', () => {
  const key = blobStore.readKey(KEY);
  const sealed = blobStore.seal(Buffer.from('CMR 42'), key);
  assert.equal(blobStore.isSealed(sealed), true);
  assert.equal(sealed.includes(Buffer.from('CMR 42')), false);
  assert.equal(blobStore.open(sealed, key).toString(), 'CMR 42');
  assert.throws(() => blobStore.open(sealed, null), /DOCUMENT_ENCRYPTION_KEY is not set/);
  assert.throws(() => blobStore.open(sealed, crypto.randomBytes(32)));
  const tampered = Buffer.from(sealed); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => blobStore.open(tampered, key));
  assert.equal(blobStore.open(Buffer.from('%PDF old file'), key).toString(), '%PDF old file');
  assert.equal(blobStore.readKey('ab'.repeat(32)).length, 32);
  assert.throws(() => blobStore.readKey('short'), /32 bytes/);
  assert.throws(() => blobStore.r2Config({ DOCUMENT_STORAGE: 'r2', R2_BUCKET: 'b' }), /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID/);
  assert.equal(blobStore.r2Config({ R2_ACCOUNT_ID: 'abc', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'b' }).endpoint, 'https://abc.r2.cloudflarestorage.com');
  process.env.DOCUMENT_STORAGE = 'dropbox';
  blobStore.resetForTests();
  assert.throws(() => blobStore.checkConfig(), /"database" or "r2"/);
  useStorage('database');
});

test('in the database with a key: the row holds only encrypted bytes; download gives the original', async () => {
  useStorage('database', KEY);
  const id = await newLoad();
  const bytes = pdf('db-encrypted');
  const doc = (await (await upload(admin, id, bytes)).json()).document;
  const row = await rawRow(doc.id);
  assert.equal(row.storageKey, null);
  assert.equal(blobStore.isSealed(Buffer.from(row.content)), true);
  assert.deepEqual((await download(admin, id, doc.id)).bytes, bytes);
});

test('in R2: the file goes to the bucket encrypted, the row keeps only the key; other companies cannot read it; delete removes it', async () => {
  useStorage('r2', KEY);
  const id = await newLoad();
  const bytes = pdf('r2');
  const res = await upload(admin, id, bytes);
  assert.equal(res.status, 201);
  const doc = (await res.json()).document;
  const row = await rawRow(doc.id);
  assert.match(row.storageKey, new RegExp(`^documents/t\\d+/s${numeric(id)}/[0-9a-f]{64}$`));
  assert.equal(Buffer.from(row.content).length, 0, 'no copy of the file stays in the database');
  const stored = objects.get(`/veyra-docs/${row.storageKey}`);
  assert.ok(stored, 'the object is in the bucket');
  assert.equal(stored.includes(Buffer.from('% r2')), false, 'the bucket sees only encrypted bytes');
  assert.deepEqual((await download(admin, id, doc.id)).bytes, bytes);
  assert.equal((await download(other, id, doc.id)).status, 404);

  // The same file again is one document and one object.
  const again = await upload(admin, id, bytes);
  assert.equal(again.status, 200);
  assert.equal([...objects.keys()].filter((key) => key.includes(`/s${numeric(id)}/`)).length, 1);

  assert.equal((await call(admin, 'DELETE', `/api/shipments/${id}/documents/${doc.id}`)).status, 200);
  assert.equal(objects.has(`/veyra-docs/${row.storageKey}`), false);
  assert.equal(refused, 0, 'every request was signed correctly');
});

test('files saved in the database earlier are moved to R2 by the move script, checked, and stay readable', async () => {
  useStorage('database');
  const id = await newLoad();
  const plain = pdf('old-plain');
  const oldDoc = (await (await upload(admin, id, plain)).json()).document;
  useStorage('database', KEY);
  const sealedBytes = pdf('old-sealed');
  const sealedDoc = (await (await upload(admin, id, sealedBytes, 'pod.pdf')).json()).document;

  // Before the move, a server switched to R2 still reads the files left in the database.
  useStorage('r2', KEY);
  assert.deepEqual((await download(admin, id, oldDoc.id)).bytes, plain);

  const moved = await runAsSystem(() => database.moveDocumentsToStorage());
  assert.ok(moved >= 2);
  for (const [doc, bytes] of [[oldDoc, plain], [sealedDoc, sealedBytes]]) {
    const row = await rawRow(doc.id);
    assert.ok(row.storageKey);
    assert.equal(Buffer.from(row.content).length, 0);
    assert.equal(blobStore.isSealed(objects.get(`/veyra-docs/${row.storageKey}`)), true, 'moved files are encrypted');
    assert.deepEqual((await download(admin, id, doc.id)).bytes, bytes);
  }
  assert.equal(await runAsSystem(() => database.moveDocumentsToStorage()), 0, 'running it again changes nothing');

  // A server that is not set up for R2 says so instead of sending an empty file.
  useStorage('database', KEY);
  assert.equal((await download(admin, id, oldDoc.id)).status, 500);
  useStorage('database');
});

test('files that came with an email are encrypted while they wait, and land in R2 when they join a load', async () => {
  useStorage('r2', KEY);
  const tenantId = (await (await call(admin, 'GET', '/api/me')).json()).user.tenantId;
  const id = await newLoad();
  const bytes = pdf('email');
  const result = await runAsSystem(async () => {
    const item = await database.sql.run("INSERT INTO inbox_items (tenant_id, source, subject, body, status) VALUES (?, 'email', 'Order', 'See CMR', 'new')", [tenantId]);
    const file = await database.addInboxAttachment(tenantId, item.id, { filename: 'cmr.pdf', mime: 'application/pdf', content: bytes });
    const waiting = await database.sql.get('SELECT content FROM inbox_attachments WHERE id = ?', [file.id]);
    const readBack = await database.getInboxAttachmentFile(tenantId, item.id, file.id);
    const movedFiles = await database.moveInboxAttachmentsToShipment(tenantId, item.id, numeric(id));
    return { waiting, readBack, movedFiles };
  });
  assert.equal(blobStore.isSealed(Buffer.from(result.waiting.content)), true);
  assert.deepEqual(result.readBack.content, bytes);
  const docId = result.movedFiles.documentIds[0];
  assert.ok((await rawRow(docId)).storageKey);
  assert.deepEqual((await download(admin, id, docId)).bytes, bytes);
  useStorage('database');
});
