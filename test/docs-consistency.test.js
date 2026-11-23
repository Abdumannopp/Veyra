// The documents agree with each other and with the evidence. The roadmap's "Open items" table is the only list of
// unfinished work; its statuses must match the evidence logs (security register, integration trial log, drill and
// load-test logs). These checks fail when a document is reworded to look finished without the evidence behind it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const docs = ['README.md', 'USER_GUIDE.md', 'DEPLOYMENT.md', ...fs.readdirSync(path.join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`)];

// The rows of the first markdown table after a heading, as arrays of trimmed cells.
function tableAfter(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `heading "${heading}" exists`);
  const rows = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (line.startsWith('|')) {
      inTable = true;
      rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
    } else if (inTable) break;
  }
  return rows.slice(2); // without the header and the --- line
}

const roadmap = read('docs/GLOBAL_ROADMAP.md');
const openItems = Object.fromEntries(tableAfter(roadmap, '## Open items').map((row) => [row[0], row[2]]));
const isDone = (id) => openItems[id] === 'Done';

test('the roadmap lists the open items with known statuses', () => {
  assert.deepEqual(Object.keys(openItems), ['O-1', 'O-2', 'O-3', 'O-4']);
  for (const [id, status] of Object.entries(openItems)) assert.ok(['Not started', 'In progress', 'Done'].includes(status), `${id}: ${status}`);
});

test('O-1 (external security review) matches SECURITY.md and roadmap step 6.4', () => {
  const security = read('docs/SECURITY.md');
  const findings = tableAfter(security, '## 4. Findings register');
  const openSerious = findings.filter((row) => /Critical|High/.test(row[2]) && !/Fixed and retested|Accepted risk/.test(row[5]));
  const step64 = roadmap.split('\n').find((line) => line.startsWith('| 6.4 |'));
  if (isDone('O-1')) {
    assert.doesNotMatch(security, /NOT DONE/, 'SECURITY.md still says the review is not done');
    assert.ok(findings.some((row) => row[0]), 'a finished review has at least its report recorded in the register');
    assert.deepEqual(openSerious, [], 'no open Critical or High finding');
  } else {
    assert.match(security, /NOT DONE/, 'SECURITY.md must say the review is not done');
    assert.match(step64, /Open/, 'roadmap 6.4 must be open');
  }
});

test('O-2 (real-service trials) matches the integration table and its trial log', () => {
  const integrations = read('docs/INTEGRATIONS.md');
  const services = tableAfter(integrations, '## Outside services');
  const log = tableAfter(integrations, '## Trial log');
  const passed = log.filter((row) => row[3] === 'Passed');
  const nameOf = (row) => /\*\*(.+?)\*\*/.exec(row[0])[1];
  for (const row of services) {
    const status = row[2];
    const tried = passed.some((entry) => entry[1].toLowerCase().includes(nameOf(row).toLowerCase()));
    if (status === 'Working') assert.ok(tried, `${nameOf(row)} is "Working" without a "Passed" trial`);
    if (row[5] === 'Not yet') assert.notEqual(status, 'Working', `${nameOf(row)} was never tried with the real service`);
  }
  const untried = services.filter((row) => row[5] === 'Not yet');
  if (isDone('O-2')) assert.deepEqual(untried.map(nameOf), [], 'O-2 is Done but some services were never tried');
  else assert.ok(untried.length > 0 || passed.length < services.length, 'every service passed: set O-2 to Done');
});

test('O-3 and O-4 (restore drill, load test) match the logs in RECOVERY.md', () => {
  const recovery = read('docs/RECOVERY.md');
  const drills = tableAfter(recovery, '## Drill log (roadmap item O-3)');
  const loads = tableAfter(recovery, '## Load-test log (roadmap item O-4)');
  const realDrill = drills.some((row) => row[3] === 'Yes' && row[4] === 'Passed');
  const realLoad = loads.some((row) => row[2] === 'Yes');
  assert.equal(isDone('O-3'), realDrill, 'O-3 is Done exactly when a drill on a real hosted copy passed');
  assert.equal(isDone('O-4'), realLoad, 'O-4 is Done exactly when a load test ran against a real hosted copy');
});

test('only the roadmap counts open items; the integration page links to it', () => {
  for (const file of docs.filter((name) => name !== 'docs/GLOBAL_ROADMAP.md')) {
    assert.doesNotMatch(read(file), /\b(the )?(one|only|single) open (item|task)\b/i, file);
  }
  const integrations = read('docs/INTEGRATIONS.md');
  const section = integrations.slice(integrations.indexOf('## In development'), integrations.indexOf('## Not connected'));
  assert.match(section, /GLOBAL_ROADMAP\.md#open-items/);
});

test('every test file named in the integration table exists', () => {
  const integrations = read('docs/INTEGRATIONS.md');
  for (const row of tableAfter(integrations, '## Outside services')) {
    for (const name of row[6].split(',').map((cell) => cell.trim()).filter(Boolean)) {
      assert.ok(fs.existsSync(path.join(root, 'test', `${name}.test.js`)), `test/${name}.test.js (named for ${row[0].slice(0, 30)})`);
    }
  }
});

test('the README says where data comes from instead of "everything is entered by people"', () => {
  const readme = read('README.md');
  assert.doesNotMatch(readme, /everything is entered by people/i);
  const sources = tableAfter(readme, '## Where the data comes from').map((row) => row[0]);
  assert.deepEqual(sources.map((cell) => /\*\*(.+?)\*\*/.exec(cell)[1]), ['Typed by people', 'Can arrive automatically', 'Worked out by Veyra']);
});

test('the index describes the design files in the language they are really in', () => {
  const svg = read('docs/design/01-dashboard.svg');
  const english = /<text[^>]*>\s*Dashboard\s*</.test(svg) && /<text[^>]*>\s*Shipments\s*</.test(svg);
  const row = read('docs/INDEX.md').split('\n').find((line) => line.includes('docs/design/'));
  if (english) {
    assert.match(row, /English/);
    assert.doesNotMatch(row, /\(in Uzbek\)/);
  }
});
