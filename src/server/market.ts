import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { sendJson } from './http.ts';

export interface MarketListing {
  id: number;
  name: string;
  seller: string;
  price: number;
  currency: 'gold';
  createdAt: string;
}

export function registerMarket(app: FastifyInstance, db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS market_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_account_id TEXT NOT NULL,
    seller_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_data TEXT NOT NULL CHECK (json_valid(item_data)),
    price INTEGER NOT NULL CHECK (price > 0),
    currency TEXT NOT NULL DEFAULT 'gold' CHECK(currency = 'gold'),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','sold','cancelled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  // Browsing is read-only until server-authoritative escrow and save locking
  // are implemented. Never create listings by trusting client-supplied items.
  app.get('/api/market/listings', (request, reply) => {
    const query = request.query as { q?: string; limit?: string };
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 60) : '';
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const rows = db.prepare(`
      SELECT id, item_name AS name, seller_name AS seller,
             price, currency, created_at AS createdAt
      FROM market_listings
      WHERE status = 'active' AND (? = '' OR item_name LIKE ? OR seller_name LIKE ?)
      ORDER BY id DESC LIMIT ?
    `).all(q, '%' + q + '%', '%' + q + '%', limit) as unknown as MarketListing[];
    return sendJson(reply, 200, { listings: rows, tradingEnabled: false });
  });
}
