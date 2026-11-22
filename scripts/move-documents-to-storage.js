// Moves document files kept in the database into Cloudflare R2 (and encrypts them when
// DOCUMENT_ENCRYPTION_KEY is set). Safe to run again: it only touches files not moved yet,
// and each file is read back from the bucket before the database copy is dropped.
// Usage (with DOCUMENT_STORAGE=r2 and the R2_* settings): node scripts/move-documents-to-storage.js
require('dotenv').config();
const database = require('../database');
const { runAsSystem } = require('../lib/tenant-context');

(async () => {
  await database.initialize();
  const moved = await runAsSystem(() => database.moveDocumentsToStorage());
  console.log(`Moved ${moved} document file(s) to object storage.`);
  await database.close?.();
  process.exit(0);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
