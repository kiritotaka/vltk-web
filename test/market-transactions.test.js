const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server/index.ts');
const { openDatabase } = require('../src/server/database.ts');
const { createMarket } = require('../src/server/market.ts');
const { accountCookie } = require('./helpers/accounts.js');

test('market settlement, authorization, rollback and replay across restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'vltk-market-'));
  const filename = path.join(directory, 'test.sqlite');
  let server = createServer({ db: openDatabase(filename), downloadAssets: false });
  let closed = false;
  async function close() {
    await server.app.close();
    server.db.close();
    closed = true;
  }
  try {
    const seller = await accountCookie(server.app, 'market_seller');
    const buyer = await accountCookie(server.app, 'market_buyer');
    const other = await accountCookie(server.app, 'market_other');
    function request(cookie, url, payload) {
      return server.app.inject({
        method: payload === undefined ? 'GET' : 'POST', url,
        headers: cookie ? { cookie } : {},
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    }
    const mine = async cookie => (await request(cookie, '/api/market/mine')).json();
    const order = (cookie, payload) => request(cookie, '/api/market/transactions', payload);
    const inventory = createMarket(server.db);
    inventory.issue('item-1', 'market_seller', { name: 'Thanh kiếm' });
    inventory.issue('item-1', 'market_seller', { name: 'Thanh kiếm' });
    inventory.issue('wallet-1', 'market_buyer', { currency: 'gold', amount: 100 });
    inventory.issue('wallet-2', 'market_other', { currency: 'gold', amount: 100 });
    const [item] = (await mine(seller)).items;
    assert.equal((await mine(seller)).items.length, 1);

    assert.equal((await request(null, '/api/market/mine')).statusCode, 401);
    assert.equal((await order(null, {})).statusCode, 401);
    const prior = (await request(seller, '/api/storage')).json();
    const save = JSON.stringify({ inventory: [{ id: 'browser-item' }], gold: 10000000 });
    const saveResponse = await request(seller, '/api/storage', {
      id: 'browser-save', generation: prior.generation, operations: [{ key: 'jxidle', value: save }],
    });
    assert.equal(saveResponse.statusCode, 200, saveResponse.body);
    const sell = { requestId: 'sell-1', action: 'sell', target: item.id, price: 60, currency: 'gold' };
    assert.equal((await order(seller, { ...sell, target: 'browser-item' })).statusCode, 409);
    assert.equal((await order(other, sell)).statusCode, 409);
    const listing = await order(seller, sell);
    assert.equal(listing.statusCode, 200, listing.body);
    assert.deepEqual((await order(seller, sell)).json(), listing.json());
    assert.equal((await order(seller, { ...sell, price: 1 })).statusCode, 409);
    const target = listing.json().listingId;
    const buy = { requestId: 'buy-1', action: 'buy', target };

    assert.equal((await order(other, { requestId: 'cancel-forbidden', action: 'cancel', target })).statusCode, 404);
    assert.equal((await order(seller, buy)).statusCode, 409);
    assert.equal((await order(buyer, { ...buy, accountId: (await mine(other)).accountId })).statusCode, 409);
    const search = await request(buyer, '/api/market/listings?q=' + encodeURIComponent('KIẾM') + '&currency=gold');
    assert.equal(search.json().listings[0].id, target);

    // Simulate a failure at the final write, after debit, item transfer and
    // order update have all executed. The same request must then be retryable.
    server.db.exec(`
      CREATE TEMP TRIGGER fail_market_receipt BEFORE INSERT ON market_receipts
      WHEN NEW.request_id='buy-1' BEGIN SELECT RAISE(ABORT, 'test rollback'); END
    `);
    assert.equal((await order(buyer, buy)).statusCode, 500);
    assert.equal((await mine(buyer)).wallet.gold, 100);
    assert.equal((await mine(buyer)).orders.length, 0);
    assert.equal((await mine(seller)).orders[0].status, 'active');
    assert.equal(server.db.prepare('SELECT state FROM market_items WHERE id=?').get(item.id).state, 'escrow');
    server.db.exec('DROP TRIGGER fail_market_receipt');

    const buyers = await Promise.all([order(buyer, buy), order(buyer, buy), order(other, buy)]);
    assert.deepEqual(buyers.map(result => result.statusCode), [200, 200, 409]);
    assert.deepEqual(buyers[0].json(), buyers[1].json());
    assert.equal((await mine(buyer)).wallet.gold, 40);
    assert.equal((await mine(other)).wallet.gold, 100);
    assert.equal((await mine(seller)).wallet.gold, 0);
    assert.equal((await mine(buyer)).items.length, 0);

    await close();
    server = createServer({ db: openDatabase(filename), downloadAssets: false });
    closed = false;
    assert.deepEqual((await order(buyer, buy)).json(), buyers[0].json());
    assert.equal((await mine(buyer)).wallet.gold, 40);
    const receive = { requestId: 'receive-1', action: 'receive', target };
    assert.equal((await order(other, receive)).statusCode, 404);
    assert.equal((await order(seller, receive)).statusCode, 200);
    assert.equal((await order(seller, receive)).statusCode, 200);
    assert.equal((await order(seller, { ...receive, requestId: 'receive-new' })).statusCode, 409);
    assert.equal((await mine(seller)).wallet.gold, 60);
    assert.equal((await order(buyer, receive)).statusCode, 200);
    assert.equal((await order(buyer, receive)).statusCode, 200);
    assert.equal((await mine(buyer)).items[0].id, item.id);
    assert.equal((await order(buyer, { ...receive, requestId: 'receive-new' })).statusCode, 409);

    const relist = await order(buyer, { ...sell, requestId: 'relist-1', price: 80 });
    assert.equal(relist.statusCode, 200, relist.body);
    const cancel = { requestId: 'cancel-1', action: 'cancel', target: relist.json().listingId };
    assert.equal((await order(other, { ...buy, requestId: 'buy-relist', target: cancel.target })).statusCode, 200);
    assert.equal((await order(buyer, cancel)).statusCode, 409);

    createMarket(server.db).issue('item-2', 'market_buyer', { name: 'Nhẫn' });
    const [ring] = (await mine(buyer)).items;
    const ringOrder = await order(buyer, { ...sell, requestId: 'ring-1', target: ring.id });
    const cancelRing = { ...cancel, target: ringOrder.json().listingId };
    assert.equal((await order(buyer, cancelRing)).statusCode, 200);
    assert.equal((await order(buyer, cancelRing)).statusCode, 200);
    assert.equal((await mine(buyer)).items[0].id, ring.id);
    assert.equal((await request(seller, '/api/storage')).json().entries.jxidle, save);
  } finally {
    if (!closed) await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
