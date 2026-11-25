// Trusted local operator command. This capability is never registered as an API.
const { openDatabase } = require('../src/server/database.ts');
const { createMarket } = require('../src/server/market.ts');

const [id, username, kind, value, arg, extra] = process.argv.slice(2);
if (!id || !username || !value || (kind === 'baseline-transfer' && value !== 'all') || !['item', 'gold', 'knb', 'character-item', 'approve-transfer', 'baseline-transfer'].includes(kind) || extra ||
    (['character-item', 'approve-transfer'].includes(kind) ? !/^\d+$/.test(arg || '') : arg !== undefined)) {
  console.error('Usage: node tools/issue-market-assets.js <issuance-id> <username> <item|gold|knb> <item-name|amount>');
  console.error('Usage: node tools/issue-market-assets.js <issuance-id> <username> character-item <slot> <gold-catalog-index>');
  console.error('Usage: node tools/issue-market-assets.js <local-reference> <username> approve-transfer <slot> <item-uid>');
  console.error('Usage: node tools/issue-market-assets.js <local-reference> <username> baseline-transfer all');
  process.exit(1);
}

const db = openDatabase();
try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts'").get()) {
    throw new Error('Khởi động máy chủ và tạo tài khoản trước khi cấp tài sản Chợ.');
  }
  const grant = kind === 'character-item' ? { character: value, catalogIndex: Number(arg) }
    : kind === 'item' ? { name: value } : { currency: kind, amount: Number(value) };
  const market = createMarket(db);
  if (kind === 'baseline-transfer') {
    const result = market.baselineInventory(username.trim().toLowerCase());
    console.log(result.alreadyRecorded ? 'Tài khoản đã có mốc Hành trang.' : 'Đã ghi nhận ' + result.count + ' món trong Hành trang.');
  } else if (kind === 'approve-transfer') {
    const approved = market.approveTransfer(username.trim().toLowerCase(), value, Number(arg));
    console.log('Đã xác nhận chuyển món: ' + approved);
  } else {
    market.issue(id, username.trim().toLowerCase(), grant);
    console.log('Đã ghi nhận mã cấp tài sản Chợ ' + id + '.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
