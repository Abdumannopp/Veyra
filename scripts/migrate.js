// Database migrations from the command line.
//   npm run migrate              apply every pending migration
//   npm run migrate -- status    list migrations and whether each is applied
//   npm run migrate -- down [n]  reverse the newest n migrations (default 1); take a backup first
require('dotenv').config({ quiet: true });
const { db, MIGRATIONS, migrationRunner } = require('../database');

const [command = 'up', count] = process.argv.slice(2);
const done = (code) => db.close(() => process.exit(code));

(async () => {
  if (command === 'status') {
    for (const row of await migrationRunner.status(MIGRATIONS)) {
      console.log(`${row.applied ? '[x]' : '[ ]'} ${row.id}  ${row.name}${row.appliedAt ? `  (applied ${row.appliedAt} UTC)` : ''}`);
    }
  } else if (command === 'up') {
    const ran = await migrationRunner.up(MIGRATIONS);
    console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Nothing to apply.');
  } else if (command === 'down') {
    const steps = Math.max(1, Number.parseInt(count, 10) || 1);
    const ran = await migrationRunner.down(MIGRATIONS, { steps });
    console.log(`Reversed: ${ran.join(', ') || 'nothing'}`);
  } else {
    console.error('Use: status | up | down [n]');
    return done(2);
  }
  return done(0);
})().catch((error) => {
  console.error('Migration failed:', error.message);
  done(1);
});
