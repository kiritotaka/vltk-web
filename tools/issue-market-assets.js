// Trusted local operator command. This capability is never registered as an API.
const { openDatabase } = require('../src/server/database.ts');
const { createMarket } = require('../src/server/market.ts');

const [id, username, kind, value, extra] = process.argv.slice(2);
if (!id || !username || !value || !['item', 'gold', 'knb'].includes(kind) || extra) {
  console.error('Usage: node tools/issue-market-assets.js <issuance-id> <username> <item|gold|knb> <item-name|amount>');
  process.exit(1);
}

const db = openDatabase();
try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts'").get()) {
    throw new Error('Khởi động máy chủ và tạo tài khoản trước khi cấp tài sản Chợ.');
  }
  const grant = kind === 'item' ? { name: value } : { currency: kind, amount: Number(value) };
  createMarket(db).issue(id, username.trim().toLowerCase(), grant);
  console.log('Đã ghi nhận mã cấp tài sản Chợ ' + id + '.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
