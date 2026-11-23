// The documents stay true to each other: links work, every document is in the index, and the integration table
// only uses the agreed status words. (A document that cannot be found or an unexplained status is how drift starts.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const docs = ['README.md', 'USER_GUIDE.md', 'DEPLOYMENT.md', ...fs.readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];

const withoutCode = (text) => text.replace(/```[\s\S]*?```/g, '');
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\w\- ]/gu, '').replace(/ /g, '-');
const anchorsOf = (file) => new Set(read(file).split('\n').map((line) => /^#{1,6}\s+(.*)/.exec(line)).filter(Boolean).map((match) => slug(match[1])));

test('every relative link in the documents points to a real file and heading', () => {
  const problems = [];
  for (const file of docs) {
    for (const match of withoutCode(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1];
      if (/^(https?:|mailto:)/.test(link)) continue;
      const [target, fragment] = link.split('#');
      const resolved = target ? path.normalize(path.join(path.dirname(file), target)) : file;
      if (!fs.existsSync(path.join(root, resolved))) problems.push(`${file}: ${link} (no such file)`);
      else if (fragment && resolved.endsWith('.md') && !anchorsOf(resolved).has(fragment)) problems.push(`${file}: ${link} (no such heading)`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every document is listed in docs/INDEX.md', () => {
  const index = read('docs/INDEX.md');
  const missing = docs.filter((file) => file !== 'docs/INDEX.md').filter((file) => !index.includes(`(${file.startsWith('docs/') ? file.slice(5) : `../${file}`}`) && !index.includes(`(${file}`));
  assert.deepEqual(missing, [], 'add it to docs/INDEX.md (and say what it is for)');
});

test('the integration table uses only the agreed status words and never calls a fake-tested service "Working"', () => {
  const lines = read('docs/INTEGRATIONS.md').split('\n');
  const outside = lines.slice(lines.findIndex((line) => line.startsWith('## Outside services')), lines.findIndex((line) => line.startsWith('## In development')));
  const rows = outside.filter((line) => line.startsWith('| **'));
  assert.ok(rows.length >= 10, 'the outside services are listed');
  const allowed = ['Test mode', 'Partial', 'Working', 'In development', 'Not connected'];
  for (const row of rows) {
    const status = row.split('|')[3].trim();
    assert.ok(allowed.includes(status), `unknown status "${status}" in: ${row.slice(0, 60)}`);
    if (/Not yet\s*\|$/.test(row)) assert.notEqual(status, 'Working', `never tried with the real service, so not "Working": ${row.slice(0, 60)}`);
  }
});

test('the documents never claim an external security audit has been done while the register is empty', () => {
  const security = read('docs/SECURITY.md');
  assert.match(security, /NOT DONE/);
  assert.match(security, /No external review has been done yet/);
  for (const file of ['README.md', 'USER_GUIDE.md', 'DEPLOYMENT.md']) {
    assert.doesNotMatch(read(file), /\b(is|was|has been) (externally )?(security[- ]audited|penetration[- ]tested)\b/i, file);
  }
});
