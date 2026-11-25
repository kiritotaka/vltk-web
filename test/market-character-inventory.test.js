const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createServer } = require('../src/server/index.ts');
const { openDatabase } = require('../src/server/database.ts');
const { createMarket } = require('../src/server/market.ts');
const { accountCookie } = require('./helpers/accounts.js');

test('a catalog item moves from the seller character to the buyer character exactly once', async () => {
  const db = openDatabase(':memory:');
  const { app } = createServer({ db, downloadAssets: false });
  try {
    const seller = await accountCookie(app, 'inv_seller');
    const buyer = await accountCookie(app, 'inv_buyer');
    const inventory = '/api/market/inventory/';
    const request = (cookie, url, data) => app.inject({
      url, method: data === undefined ? 'GET' : 'POST', headers: { cookie },
      ...(data === undefined ? {} : { payload: JSON.stringify(data) }),
    });
    const orders = (cookie, data) => request(cookie, '/api/market/transactions', data);
    const listItems = async (cookie, slot) => {
      const response = await request(cookie, inventory + slot);
      assert.equal(response.statusCode, 200, response.body);
      return response.json().items;
    };
    const fakeInventory = JSON.stringify({ inv: [{ uid: 1, n: 'Client-only item' }], gold: 5000 });
    for (const [cookie, username] of [[seller, 'seller'], [buyer, 'buyer']]) {
      const storage = (await request(cookie, '/api/storage')).json();
      const response = await request(cookie, '/api/storage', { id: 'save-' + username, generation: storage.generation,
        operations: [{ key: 'jxidle', value: fakeInventory }, { key: 'jxidle_2', value: fakeInventory }] });
      assert.equal(response.statusCode, 200, response.body);
    }
    const market = createMarket(db);
    const catalog = JSON.parse(db.prepare("SELECT data FROM game_data WHERE section='sets' AND entry_key='gold'").get().data);
    const index = catalog.findIndex(item => item.n === 'Càn Khôn Giới Chỉ');
    assert.ok(index >= 0);
    market.issue('real-equipment', 'inv_seller', { character: 'jxidle', catalogIndex: index });
    market.issue('real-equipment', 'inv_seller', { character: 'jxidle', catalogIndex: index });
    market.issue('buyer-wallet', 'inv_buyer', { currency: 'gold', amount: 100 });
    const items = await listItems(seller, 'jxidle');
    assert.equal(items.length, 1);
    const [asset] = items;
    assert.deepEqual(asset.item, catalog[index]);
    assert.equal((await listItems(seller, 'jxidle_2')).length, 0);
    assert.equal((await request(seller, '/api/market/mine')).json().items.length, 0);

    const sell = { requestId: 'seller-list', action: 'sell', character: 'jxidle', target: asset.id, currency: 'gold', price: 60 };
    assert.equal((await orders(buyer, sell)).statusCode, 409);
    assert.equal((await orders(seller, { ...sell, character: 'jxidle_2' })).statusCode, 409);
    assert.equal((await orders(seller, { ...sell, target: 'client-only' })).statusCode, 409);
    const first = await orders(seller, sell);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((await listItems(seller, 'jxidle')).length, 0);
    const oldListing = first.json().listingId;
    const cancel = { requestId: 'cancel-list', action: 'cancel', target: oldListing };
    assert.equal((await orders(buyer, cancel)).statusCode, 404);
    assert.equal((await orders(seller, cancel)).statusCode, 200);
    assert.equal((await orders(seller, cancel)).statusCode, 200);
    assert.deepEqual(await listItems(seller, 'jxidle'), [asset]);

    db.exec(`CREATE TEMP TRIGGER fail_inventory_listing BEFORE INSERT ON market_receipts
      WHEN NEW.request_id='sell-again' BEGIN SELECT RAISE(ABORT,'forced inventory rollback'); END`);
    const relist = { ...sell, requestId: 'sell-again' };
    assert.equal((await orders(seller, relist)).statusCode, 500);
    assert.deepEqual(await listItems(seller, 'jxidle'), [asset]);
    db.exec('DROP TRIGGER fail_inventory_listing');
    const pending = await orders(seller, relist);
    assert.equal(pending.statusCode, 200, pending.body);
    assert.deepEqual((await orders(seller, relist)).json(), pending.json());
    const target = pending.json().listingId;
    assert.equal((await request(buyer, '/api/market/listings')).json().listings[0].id, target);
    const buy = { requestId: 'buy-equipment', action: 'buy', target };
    assert.equal((await orders(buyer, buy)).statusCode, 200);
    assert.equal((await orders(buyer, buy)).statusCode, 200);
    assert.equal((await listItems(buyer, 'jxidle_2')).length, 0);
    assert.equal((await orders(seller, { ...cancel, target, requestId: 'cancel-sold' })).statusCode, 409);

    const receive = { requestId: 'receive-item', action: 'receive', target, character: 'jxidle_2' };
    assert.equal((await orders(buyer, { ...receive, character: 'jxidle_3' })).statusCode, 409);
    assert.equal((await orders(buyer, receive)).statusCode, 200);
    assert.equal((await orders(buyer, receive)).statusCode, 200);
    assert.deepEqual(await listItems(buyer, 'jxidle_2'), [asset]);
    assert.equal((await listItems(buyer, 'jxidle')).length, 0);
    assert.equal((await listItems(seller, 'jxidle')).length, 0);
    const payout = { requestId: 'collect-gold', action: 'receive', target };
    assert.equal((await orders(seller, payout)).statusCode, 200);
    assert.equal((await orders(seller, payout)).statusCode, 200);
    assert.equal((await request(seller, '/api/market/mine')).json().wallet.gold, 60);
    assert.equal((await request(buyer, '/api/market/mine')).json().wallet.gold, 40);
    for (const cookie of [seller, buyer]) {
      assert.equal((await request(cookie, '/api/storage')).json().entries.jxidle, fakeInventory);
    }
  } finally { await app.close(); db.close(); }
});

test('Bày bán lists the selected character inventory and submits its server item ID', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/client/online/local-market-01.js'), 'utf8');
  const requests = [];
  const pending = new Map();
  function element() {
    return {
      children: [],
      get childElementCount() { return this.children.length; },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren() { this.children = []; },
      setAttribute() {},
    };
  }
  const elements = new Map();
  const root = {
    querySelector(selector) {
      if (selector === '#mktSearch') return null;
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
  };
  const browser = {
    URLSearchParams, y8: () => 'jxidle_2', m: selector => selector === '#localMarket' ? root : null,
    J: (_html, ready) => ready(),
    document: { createElement: element },
    Option: class Option { constructor(label, value) { this.label = label; this.value = value; } },
    crypto: { randomUUID: () => 'browser-action' },
    sessionStorage: {
      getItem: key => pending.get(key) || null,
      setItem: (key, value) => pending.set(key, value),
      removeItem: key => pending.delete(key),
    },
    async fetch(url, options) {
      requests.push([url, options.body]);
      const data = url.endsWith('/mine') ? { accountId: 'account', wallet: { gold: 0, knb: 0 }, items: [] }
        : url.endsWith('/inventory/jxidle_2') ? { items: [{ id: 'server-item', name: 'Nhẫn', item: { lvl: 10 } }] }
          : { listingId: 'list-id' };
      return { ok: true, json: async () => data };
    },
  };
  vm.runInNewContext(source, browser);
  browser.localMarket.open('sell');
  await new Promise(resolve => setImmediate(resolve));
  const [row] = root.querySelector('#mktListings').children;
  assert.equal(row.children[0].textContent, 'Nhẫn');
  row.children[1].valueAsNumber = 25;
  row.children[2].value = 'gold';
  row.children[3].onclick();
  await new Promise(resolve => setImmediate(resolve));
  const post = requests.find(([url]) => url.endsWith('/transactions'));
  assert.deepEqual(JSON.parse(post[1]), {
    action: 'sell', target: 'server-item', price: 25, currency: 'gold',
    accountId: 'account', character: 'jxidle_2', requestId: 'browser-action',
  });
});
