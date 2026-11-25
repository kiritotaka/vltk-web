// Local-only administrator tool. Never expose this through an HTTP endpoint.
const { openDatabase } = require('../src/server/database.ts');
const username = String(process.argv[2] || '').trim().toLowerCase();
const role = String(process.argv[3] || '').trim().toLowerCase();

if (!/^[a-z0-9_]{3,16}$/.test(username) || !['user','gm','admin'].includes(role)) {
  console.error('Usage: node tools/set-account-role.js <existing-username> <user|gm|admin>');
  process.exit(1);
}

const db = openDatabase();
try {
  // One-time safe schema migration also supports an offline server.
  const columns = db.prepare('PRAGMA table_info(accounts)').all();
  if (!columns.length) throw new Error('No existing accounts table. Start the server and create the account first.');
  if (!columns.some(column => column.name === 'role'))
    db.exec("ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','gm','admin'))");

  const target = db.prepare('SELECT id,username,role FROM accounts WHERE username=?').get(username);
  if (!target) throw new Error('Account ' + username + ' not found. Log into the game or register this username first.');

  const previous = target.role;
  db.prepare('UPDATE accounts SET role=? WHERE id=?').run(role, target.id);
  console.log('Account ' + username + ': ' + previous + ' -> ' + role);
  console.log('Other accounts were not changed. Reload the game to update session permissions.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
