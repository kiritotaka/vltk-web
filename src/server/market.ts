import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseJsonBody, sendJson } from './http.ts';
import { legacyMarketInventory } from './market-legacy-inventory.ts';
import { characterInventory, marketCharacterSlot, type CharacterSlot } from './market-character-inventory.ts';

const MAX_MONEY = Number.MAX_SAFE_INTEGER;
const TOKEN = /^[a-zA-Z0-9-]{1,80}$/;
const currencies = ['gold', 'knb'] as const;
type Currency = typeof currencies[number];
type Command = ({ action: 'sell'; target: string; price: number; currency: Currency }
  | { action: 'buy' | 'cancel' | 'receive'; target: string }) & { character?: CharacterSlot };
type Grant = { name: string } | { currency: Currency; amount: number } | { character: CharacterSlot; catalogIndex: number };
type Listing = { id: string; item_id: string; seller_id: string; buyer_id: string | null;
  status: 'active' | 'sold' | 'cancelled'; price: number; currency: Currency;
  seller_received: number; buyer_received: number };

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function currency(value: unknown): Currency {
  if (value === 'gold' || value === 'knb') return value;
  return fail(400, 'Đơn vị tiền Chợ không hợp lệ.');
}

function amount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  return fail(400, 'Số tiền Chợ phải là số nguyên dương.');
}

function token(value: unknown): string {
  if (typeof value === 'string' && TOKEN.test(value)) return value;
  return fail(400, 'Mã yêu cầu hoặc mã tài sản không hợp lệ.');
}

function command(input: unknown): { requestId: string; data: Command } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Yêu cầu Chợ không hợp lệ.');
  const body = input as Record<string, unknown>;
  const requestId = token(body.requestId);
  const target = token(body.target);
  const scope = body.character === undefined ? {} : { character: marketCharacterSlot(body.character) };
  switch (body.action) {
    case 'sell': return { requestId, data: { action: 'sell', target, price: amount(body.price), currency: currency(body.currency), ...scope } };
    case 'buy':
    case 'cancel':
    case 'receive': return { requestId, data: { action: body.action, target, ...scope } };
    default: return fail(400, 'Thao tác Chợ không hợp lệ.');
  }
}

export function createMarket(db: DatabaseSync) {
  // Market assets are issued locally by trusted server code. Account save data
  // never feeds these tables, and market actions never write character saves.
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_wallet (
      owner_id TEXT NOT NULL REFERENCES accounts(id),
      currency TEXT NOT NULL CHECK(currency IN ('gold','knb')),
      balance INTEGER NOT NULL CHECK(balance BETWEEN 0 AND ${MAX_MONEY}),
      PRIMARY KEY(owner_id, currency)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS market_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      search_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('available','escrow','pending'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS market_items_owner ON market_items(owner_id, state);
    CREATE TABLE IF NOT EXISTS market_orders (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES market_items(id),
      seller_id TEXT NOT NULL REFERENCES accounts(id),
      buyer_id TEXT REFERENCES accounts(id),
      status TEXT NOT NULL CHECK(status IN ('active','sold','cancelled')),
      price INTEGER NOT NULL CHECK(price BETWEEN 1 AND ${MAX_MONEY}),
      currency TEXT NOT NULL CHECK(currency IN ('gold','knb')),
      created_at INTEGER NOT NULL,
      seller_received INTEGER NOT NULL DEFAULT 0 CHECK(seller_received IN (0,1)),
      buyer_received INTEGER NOT NULL DEFAULT 0 CHECK(buyer_received IN (0,1)),
      CHECK((status = 'sold') = (buyer_id IS NOT NULL)),
      CHECK(buyer_id IS NULL OR buyer_id <> seller_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS market_orders_active_item ON market_orders(item_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS market_orders_status ON market_orders(status, created_at, id);
    CREATE INDEX IF NOT EXISTS market_orders_seller ON market_orders(seller_id, created_at);
    CREATE INDEX IF NOT EXISTS market_orders_buyer ON market_orders(buyer_id, created_at);
    CREATE TABLE IF NOT EXISTS market_receipts (
      owner_id TEXT NOT NULL REFERENCES accounts(id),
      request_id TEXT NOT NULL,
      command TEXT NOT NULL,
      result TEXT NOT NULL,
      PRIMARY KEY(owner_id, request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS market_issuance (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL
    ) STRICT;
  `);

  const characters = characterInventory(db);
  const legacy = legacyMarketInventory(db);

  function transaction<T>(write: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = write();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function credit(owner: string, unit: Currency, value: number) {
    const { changes } = db.prepare(`
      INSERT INTO market_wallet(owner_id,currency,balance) VALUES (?,?,?)
      ON CONFLICT(owner_id,currency) DO UPDATE SET balance=balance+excluded.balance
      WHERE balance <= ${MAX_MONEY}-excluded.balance
    `).run(owner, unit, value);
    if (changes !== 1) fail(409, 'Ví Chợ đã đạt giới hạn.');
  }

  function moveItem(id: string, owner: string, from: string, nextOwner: string, to: string) {
    const { changes } = db.prepare('UPDATE market_items SET owner_id=?,state=? WHERE id=? AND owner_id=? AND state=?')
      .run(nextOwner, to, id, owner, from);
    if (changes !== 1) fail(409, 'Vật phẩm không khả dụng.');
  }

  function execute(owner: string, input: unknown) {
    const { requestId, data } = command(input);
    const expectedOwner = (input as Record<string, unknown>).accountId;
    if (expectedOwner !== undefined && expectedOwner !== owner) fail(409, 'Tài khoản Chợ đã thay đổi.');
    const signature = JSON.stringify(data);
    return transaction(() => {
      const receipt = db.prepare('SELECT command,result FROM market_receipts WHERE owner_id=? AND request_id=?')
        .get(owner, requestId);
      if (receipt) {
        if (receipt.command !== signature) fail(409, 'Mã yêu cầu đã được dùng cho thao tác khác.');
        return JSON.parse(receipt.result as string) as { listingId: string; reloadCharacter?: boolean };
      }

      let listingId = data.target;
      let reloadCharacter = false;
      if (data.action === 'sell') {
        const approval = data.character && legacy.check(owner, data.character, data.target);
        if (data.character && approval && !approval.consumed) {
          const item = legacy.take(owner, data.character, approval);
          db.prepare("INSERT INTO market_items VALUES (?,?,?,?,'available')")
            .run(approval.id, owner, item.name, item.name.normalize('NFC').toLowerCase());
          characters.add(approval.id, owner, data.character, item.payload);
          reloadCharacter = true;
        }
        characters.requireSource(data.target, data.character);
        if (data.character) characters.checkSlot(owner, data.character);
        moveItem(data.target, owner, 'available', owner, 'escrow');
        listingId = randomUUID();
        db.prepare('INSERT INTO market_orders(id,item_id,seller_id,status,price,currency,created_at) VALUES (?,?,?,\'active\',?,?,?)')
          .run(listingId, data.target, owner, data.price, data.currency, Date.now());
      } else {
        const listing = db.prepare('SELECT * FROM market_orders WHERE id=?').get(listingId) as Listing | undefined;
        if (!listing) fail(404, 'Không tìm thấy tin Chợ.');
        if (data.action === 'buy') {
          if (listing.status !== 'active' || listing.seller_id === owner) fail(409, 'Tin Chợ không thể mua.');
          const { changes } = db.prepare('UPDATE market_wallet SET balance=balance-? WHERE owner_id=? AND currency=? AND balance>=?')
            .run(listing.price, owner, listing.currency, listing.price);
          if (changes !== 1) fail(409, 'Ví Chợ không đủ tiền.');
          moveItem(listing.item_id, listing.seller_id, 'escrow', owner, 'pending');
          db.prepare("UPDATE market_orders SET status='sold',buyer_id=? WHERE id=?").run(owner, listingId);
        } else if (data.action === 'cancel') {
          if (listing.seller_id !== owner) fail(404, 'Không tìm thấy tin Chợ.');
          if (listing.status !== 'active') fail(409, 'Tin Chợ đã đóng.');
          moveItem(listing.item_id, owner, 'escrow', owner, 'available');
          db.prepare("UPDATE market_orders SET status='cancelled' WHERE id=?").run(listingId);
        } else {
          if (listing.seller_id !== owner && listing.buyer_id !== owner) fail(404, 'Không tìm thấy tin Chợ.');
          if (listing.status !== 'sold') fail(409, 'Giao dịch chưa hoàn tất.');
          if (listing.buyer_id === owner && !listing.buyer_received) {
            if (characters.hasCharacterItem(listing.item_id)) characters.assign(listing.item_id, owner, marketCharacterSlot(data.character));
            moveItem(listing.item_id, owner, 'pending', owner, 'available');
            db.prepare('UPDATE market_orders SET buyer_received=1 WHERE id=?').run(listingId);
          } else if (listing.seller_id === owner && !listing.seller_received) {
            credit(owner, listing.currency, listing.price);
            db.prepare('UPDATE market_orders SET seller_received=1 WHERE id=?').run(listingId);
          } else {
            fail(409, 'Tài sản giao dịch đã được nhận.');
          }
        }
      }
      const result = { listingId, ...(reloadCharacter ? { reloadCharacter } : {}) };
      db.prepare('INSERT INTO market_receipts VALUES (?,?,?,?)').run(owner, requestId, signature, JSON.stringify(result));
      return result;
    });
  }

  // Offline issuance only. Stable issuance IDs also make operator retries safe.
  function issue(id: string, username: string, grant: Grant) {
    token(id);
    const data: Grant = 'character' in grant ? { character: marketCharacterSlot(grant.character), catalogIndex: grant.catalogIndex }
      : 'name' in grant ? { name: grant.name.trim() } : { currency: currency(grant.currency), amount: amount(grant.amount) };
    if ('name' in data && (!data.name || data.name.length > 100)) fail(400, 'Tên vật phẩm Chợ không hợp lệ.');
    transaction(() => {
      const owner = db.prepare('SELECT id FROM accounts WHERE username=?').get(username)?.id as string | undefined;
      if (!owner) fail(404, 'Không tìm thấy tài khoản.');
      const signature = JSON.stringify({ owner, data });
      const previous = db.prepare('SELECT command FROM market_issuance WHERE id=?').get(id);
      if (previous?.command === signature) return;
      if (previous) fail(409, 'Mã cấp tài sản đã được dùng.');
      if ('currency' in data) credit(owner, data.currency, data.amount);
      else {
        const id = randomUUID();
        const item = 'character' in data ? characters.catalogItem(data.catalogIndex) : { name: data.name, payload: undefined };
        db.prepare("INSERT INTO market_items VALUES (?,?,?,?,'available')")
          .run(id, owner, item.name, item.name.normalize('NFC').toLowerCase());
        if ('character' in data && item.payload !== undefined) characters.add(id, owner, data.character, item.payload);
      }
      db.prepare('INSERT INTO market_issuance VALUES (?,?)').run(id, signature);
    });
  }

  function browse(owner: string, query: Record<string, unknown>) {
    const filter = typeof query.q === 'string' ? query.q.trim().slice(0, 60).normalize('NFC').toLowerCase() : '';
    const unit = query.currency ? currency(query.currency) : '';
    const page = typeof query.page === 'string' && /^\d{1,5}$/.test(query.page) ? Number(query.page) : 0;
    const sort = query.sort === 'lo' ? 'o.price ASC,' : query.sort === 'hi' ? 'o.price DESC,' : '';
    const rows = db.prepare(`
      SELECT o.id,o.price,o.currency,i.name AS item_name,a.username AS seller_name,o.seller_id=? AS own
      FROM market_orders o JOIN market_items i ON i.id=o.item_id JOIN accounts a ON a.id=o.seller_id
      WHERE o.status='active' AND (?='' OR o.currency=?)
        AND (?='' OR instr(i.search_name,?)>0 OR instr(a.username,?)>0)
      ORDER BY ${sort} o.created_at DESC,o.id DESC LIMIT 16 OFFSET ?
    `).all(owner, unit, unit, filter, filter, filter, page * 15);
    return { listings: rows.slice(0, 15), hasMore: rows.length > 15 };
  }

  function inventory(owner: string) {
    const wallet = Object.fromEntries(currencies.map(unit => [unit, db.prepare(
      'SELECT balance FROM market_wallet WHERE owner_id=? AND currency=?').get(owner, unit)?.balance ?? 0]));
    const items = db.prepare(`SELECT i.id,i.name FROM market_items i
      WHERE i.owner_id=? AND i.state='available' AND NOT EXISTS
        (SELECT 1 FROM market_character_items c WHERE c.item_id=i.id) ORDER BY i.name,i.id`).all(owner);
    const orders = db.prepare(`
      SELECT o.id,o.status,o.price,o.currency,i.name AS item_name,o.seller_id=? AS own,
        CASE WHEN o.seller_id=? THEN o.seller_received ELSE o.buyer_received END AS received
      FROM market_orders o JOIN market_items i ON i.id=o.item_id
      WHERE o.seller_id=? OR o.buyer_id=? ORDER BY o.created_at DESC,o.id DESC
    `).all(owner, owner, owner, owner);
    return { accountId: owner, wallet, items, orders };
  }

  function approveTransfer(username: string, slot: CharacterSlot, uid: number) {
    return transaction(() => {
      const owner = db.prepare('SELECT id FROM accounts WHERE username=?').get(username)?.id as string | undefined;
      if (!owner) fail(404, 'Không tìm thấy tài khoản.');
      return legacy.approve(owner, marketCharacterSlot(slot), uid);
    });
  }
  function baselineInventory(username: string) {
    return transaction(() => {
      const owner = db.prepare('SELECT id FROM accounts WHERE username=?').get(username)?.id as string | undefined;
      if (!owner) fail(404, 'Không tìm thấy tài khoản.');
      return legacy.baseline(owner);
    });
  }

  const characterItems = (owner: string, slot: CharacterSlot) =>
    [...characters.available(owner, slot), ...legacy.available(owner, slot)];

  return { browse, inventory, execute, issue, characterItems, approveTransfer, baselineInventory };
}

export function registerMarket(app: FastifyInstance, db: DatabaseSync, requireUser: (request: FastifyRequest) => { id: string }) {
  const market = createMarket(db);
  app.get<{ Querystring: Record<string, unknown> }>('/api/market/listings', (request, reply) =>
    sendJson(reply, 200, market.browse(requireUser(request).id, request.query)));
  app.get<{ Params: { slot: string } }>('/api/market/inventory/:slot', (request, reply) =>
    sendJson(reply, 200, { items: market.characterItems(requireUser(request).id, marketCharacterSlot(request.params.slot)) }));
  app.get('/api/market/mine', (request, reply) =>
    sendJson(reply, 200, market.inventory(requireUser(request).id)));
  app.post('/api/market/transactions', (request, reply) =>
    sendJson(reply, 200, market.execute(requireUser(request).id, parseJsonBody(request.body))));
}
