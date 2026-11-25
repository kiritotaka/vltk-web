const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/server/database.ts');
const { createServer } = require('../src/server/index.ts');

test('market browse is backed by SQLite, searchable and read-only', async () => {
  const db = openDatabase(':memory:');
  const { app } = createServer({ db, downloadAssets: false });
  try {
    const empty = await app.inject('/api/market/listings');
    assert.equal(empty.statusCode, 200, empty.body);
    assert.deepEqual(empty.json(), { listings: [], tradingEnabled: false });
    db.prepare('INSERT INTO market_listings(seller_account_id,seller_name,item_name,item_data,price) VALUES(?,?,?,?,?)')
      .run('test-acc', 'Kiếm Khách', 'Thanh kiếm thử nghiệm', '{}', 5000);
    db.prepare('INSERT INTO market_listings(seller_account_id,seller_name,item_name,item_data,price,status) VALUES(?,?,?,?,?,?)')
      .run('test-acc', 'Kiếm Khách', 'Món đã gỡ', '{}', 1000, 'cancelled');

    const result = await app.inject('/api/market/listings?q=' + encodeURIComponent('kiếm'));
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().listings.length, 1);
    assert.equal(result.json().listings[0].name, 'Thanh kiếm thử nghiệm');
    assert.equal(result.json().listings[0].price, 5000);
    assert.ok(!('seller_account_id' in result.json().listings[0]));
    assert.ok(!('item_data' in result.json().listings[0]));
    assert.equal((await app.inject('/api/market/listings?q=' + encodeURIComponent('không có'))).json().listings.length, 0);

    // Trading must be integrated with authoritative inventory & wallet first.
    for (const path of ['/api/market/buy','/api/market/sell','/api/market/cancel']) {
      const rejected = await app.inject({ method:'POST', url:path, payload:{} });
      assert.notEqual(rejected.statusCode, 200, path + ' must not accept unaudited transactions');
    }
    const page = await app.inject('/market.html');
    assert.equal(page.statusCode, 200);
    const script = await app.inject('/market.js');
    assert.equal(script.statusCode, 200);
  } finally {
    await app.close();
    db.close();
  }
});
