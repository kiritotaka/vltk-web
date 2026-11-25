import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseJsonBody, sendJson } from './http.ts';

type Authenticated = { id: string; username: string };
type RequireUser = (request: FastifyRequest) => Authenticated;

export function registerLocalChat(app: FastifyInstance, db: DatabaseSync, requireUser: RequireUser): void {
  db.exec(`CREATE TABLE IF NOT EXISTS local_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    username TEXT NOT NULL,
    body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 180),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS local_chat_created_idx ON local_chat_messages(id DESC);`);

  app.get('/api/chat/messages', (request, reply) => {
    requireUser(request);
    const rows = db.prepare('SELECT id, username, body, created_at AS createdAt FROM local_chat_messages ORDER BY id DESC LIMIT 60').all();
    return sendJson(reply, 200, { messages: rows.reverse() });
  });

  app.post('/api/chat/messages', (request, reply) => {
    const user = requireUser(request);
    const input = parseJsonBody(request.body) as { body?: unknown } | null;
    if (!input || typeof input.body !== 'string') throw Object.assign(new Error('Tin nhắn không hợp lệ.'), { status:400 });
    const body = input.body.replace(/\s+/g, ' ').trim();
    if (!body || body.length > 180 || /[\x00-\x08\x0b-\x1f]/.test(body))
      throw Object.assign(new Error('Tin nhắn cần 1–180 ký tự.'), { status:400 });
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const last = db.prepare('SELECT created_at FROM local_chat_messages WHERE account_id=? ORDER BY id DESC LIMIT 1').get(user.id) as { created_at:number } | undefined;
      if (last && now - last.created_at < 3000) throw Object.assign(new Error('Vui lòng chờ 3 giây trước khi gửi tiếp.'), { status:429 });
      const result = db.prepare('INSERT INTO local_chat_messages(account_id,username,body,created_at) VALUES (?,?,?,?)')
        .run(user.id, user.username, body, now);
      db.prepare('DELETE FROM local_chat_messages WHERE id < (SELECT max(id)-1000 FROM local_chat_messages)').run();
      db.exec('COMMIT');
      return sendJson(reply, 201, { message: { id:Number(result.lastInsertRowid), username:user.username, body, createdAt:now } });
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}
