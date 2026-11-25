import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { createBattlefieldRoster } from './battlefield-roster.ts';
import { parseBattlefieldMove } from './battlefield-movement.ts';
import { parseJsonBody, sendJson } from './http.ts';

const characterSlots = new Set(['jxidle', 'jxidle_2', 'jxidle_3']);

function command(request: FastifyRequest): Record<string, unknown> {
  const value = parseJsonBody(request.body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('Yêu cầu tham chiến không hợp lệ.'), { status: 400 });
  }
  return value as Record<string, unknown>;
}

export function registerBattlefieldRoster(
  app: FastifyInstance,
  db: DatabaseSync,
  requireUser: (request: FastifyRequest) => { id: string },
  roster = createBattlefieldRoster(),
) {
  const selectCharacter = db.prepare('SELECT value FROM account_storage WHERE account_id=? AND key=?');
  app.post('/api/battlefield/roster/join', (request, reply) => {
    const account = requireUser(request);
    const { team, slot } = command(request);
    if ((team !== 'song' && team !== 'jin') || typeof slot !== 'string' || !characterSlots.has(slot)) {
      throw Object.assign(new Error('Hãy chọn phe và ô nhân vật hợp lệ.'), { status: 400 });
    }
    const raw = selectCharacter.get(account.id, slot)?.value;
    let character;
    try {
      if (typeof raw === 'string') {
        character = JSON.parse(raw);
        if (typeof character?.d === 'string') character = JSON.parse(character.d);
      }
    } catch { /* A corrupted save cannot enter a match. */ }
    if (!character || typeof character.fac !== 'string' || !character.fac || typeof character.name !== 'string' || !character.name.trim()) {
      throw Object.assign(new Error('Hãy lưu nhân vật trước khi tham gia Tống Kim.'), { status: 409 });
    }
    return sendJson(reply, 200, roster.join(account.id, team, character.name.trim().slice(0, 48)));
  });

  for (const action of ['sync', 'leave'] as const) {
    app.post('/api/battlefield/roster/' + action, (request, reply) => {
      const account = requireUser(request);
      const { matchId, participantId, movement } = command(request);
      if (typeof matchId !== 'string' || typeof participantId !== 'string' || matchId.length > 36 || participantId.length > 36) {
        throw Object.assign(new Error('Mã trận hoặc suất tham gia không hợp lệ.'), { status: 400 });
      }
      const updated = action === 'sync'
        ? roster.sync(account.id, matchId, participantId, parseBattlefieldMove(movement))
        : roster.leave(account.id, matchId, participantId);
      return sendJson(reply, 200, updated);
    });
  }
}
