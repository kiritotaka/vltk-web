import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CharacterSlot } from './market-character-inventory.ts';

type Item = { uid: number; n: string; d: number; lock?: boolean; ktc?: unknown };
type State = { inv?: unknown[]; [key: string]: unknown };
type Approval = { id: string; uid: number; digest: string; consumed: number };

function error(message: string): never {
  throw Object.assign(new Error(message), { status: 409 });
}

function checksum(payload: string): string {
  let left = 3735928559, right = 1103547991;
  const content = 'jx-idle-v1:' + payload;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    left = Math.imul(left ^ code, 2654435761);
    right = Math.imul(right ^ code, 1597334677);
  }
  left = Math.imul(left ^ (left >>> 16), 2246822507) ^ Math.imul(right ^ (right >>> 13), 3266489909);
  right = Math.imul(right ^ (right >>> 16), 2246822507) ^ Math.imul(left ^ (left >>> 13), 3266489909);
  return (4294967296 * (2097151 & right) + (left >>> 0)).toString(36);
}

function decode(value: string) {
  try {
    const envelope = JSON.parse(value);
    const encoded = typeof envelope?.d === 'string' && typeof envelope?.h === 'string';
    if (encoded && checksum(envelope.d) !== envelope.h) return null;
    const state: State = encoded ? JSON.parse(envelope.d) : envelope;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    return { state, encode: () => {
      const content = JSON.stringify(state);
      return encoded ? JSON.stringify({ ...envelope, d: content, h: checksum(content) }) : content;
    } };
  } catch { return null; }
}

function candidate(state: State, uid: number): Item {
  const found = (state.inv ?? []).filter(item => item && typeof item === 'object' && (item as Item).uid === uid);
  const item = found[0] as Item | undefined;
  if (found.length !== 1 || !item || item.lock || item.ktc || !Number.isInteger(item.d) || item.d < 0 || item.d > 9 ||
    typeof item.n !== 'string' || !item.n.trim() || item.n.length > 100) {
    error('Món đồ không ở Hành trang, đang khóa hoặc không thuộc loại trang bị có thể chuyển.');
  }
  return item;
}

const fingerprint = (item: Item) => createHash('sha256').update(JSON.stringify(item)).digest('hex');

function strip(state: State, ids: Set<number>, digests: Set<string>): boolean {
  let changed = false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Item;
    if (Number.isSafeInteger(item.uid) && typeof item.n === 'string' &&
      (ids.has(item.uid) || digests.has(fingerprint(item)))) return true;
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) {
        if (visit(value[index])) { value.splice(index, 1); changed = true; }
      }
    } else {
      for (const [key, entry] of Object.entries(value)) {
        if (visit(entry)) { delete (value as State)[key]; changed = true; }
      }
    }
    return false;
  };
  visit(state);
  return changed;
}

export function legacyMarketInventory(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_inventory_transfers (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES accounts(id),
      slot TEXT NOT NULL CHECK(slot IN ('jxidle','jxidle_2','jxidle_3')),
      uid INTEGER NOT NULL,
      digest TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
      UNIQUE(owner_id,slot,uid)
    ) STRICT;
  `);
  const select = db.prepare('SELECT value FROM account_storage WHERE account_id=? AND key=?');

  function load(owner: string, slot: CharacterSlot) {
    const row = select.get(owner, slot);
    const decoded = typeof row?.value === 'string' ? decode(row.value) : null;
    if (!decoded || !Array.isArray(decoded.state.inv)) error('Không đọc được Hành trang đang lưu.');
    return decoded;
  }

  // Admission is local operator authority and never exposed as an HTTP route.
  function approve(owner: string, slot: CharacterSlot, uid: number) {
    if (!Number.isSafeInteger(uid) || uid < 1 || uid === Number.MAX_SAFE_INTEGER) error('Mã vật phẩm không hợp lệ.');
    const item = candidate(load(owner, slot).state, uid);
    const digest = fingerprint(item);
    const result = db.prepare('SELECT id,uid,digest,consumed FROM market_inventory_transfers WHERE owner_id=? AND slot=? AND uid=?')
      .get(owner, slot, uid) as Approval | undefined;
    if (result) {
      if (!result.consumed && result.digest === digest) return result.id;
      error('Mã vật phẩm đã được dùng hoặc món đã thay đổi.');
    }
    const id = randomUUID();
    db.prepare('INSERT INTO market_inventory_transfers(id,owner_id,slot,uid,digest) VALUES (?,?,?,?,?)')
      .run(id, owner, slot, uid, digest);
    return id;
  }

  function check(owner: string, slot: CharacterSlot, id: string) {
    const row = db.prepare('SELECT id,uid,digest,consumed FROM market_inventory_transfers WHERE id=? AND owner_id=? AND slot=?')
      .get(id, owner, slot) as Approval | undefined;
    return row;
  }

  function sanitize(owner: string, key: string, value: string): string {
    const slot = /^(jxidle(?:_[23])?)(?:_bak)?$/.exec(key)?.[1];
    if (!slot && key !== 'jxidle_stash' && key !== 'jxidle_stash_bak') return value;
    const rows = db.prepare('SELECT uid,slot,digest FROM market_inventory_transfers WHERE owner_id=? AND consumed=1').all(owner);
    if (!rows.length) return value;
    const decoded = decode(value);
    if (!decoded) error('Không nhận bản lưu không hợp lệ sau khi chuyển vật phẩm sang Chợ.');
    const ids = new Set(rows.filter(row => row.slot === slot).map(row => Number(row.uid)));
    const digests = new Set(rows.map(row => row.digest as string));
    const removed = strip(decoded.state, ids, digests);
    const nextUid = ids.size ? Math.max(...ids) + 1 : 1;
    const raiseCounter = typeof decoded.state.uid === 'number' && decoded.state.uid < nextUid;
    if (raiseCounter) decoded.state.uid = nextUid;
    return removed || raiseCounter ? decoded.encode() : value;
  }

  function take(owner: string, slot: CharacterSlot, approval: Approval) {
    if (approval.consumed) error('Món đã được chuyển sang Chợ.');
    const item = candidate(load(owner, slot).state, approval.uid);
    if (fingerprint(item) !== approval.digest) error('Món đã thay đổi kể từ lúc được máy chủ xác nhận.');
    db.prepare('UPDATE market_inventory_transfers SET consumed=1 WHERE id=?').run(approval.id);
    const entries = db.prepare('SELECT key,value FROM account_storage WHERE account_id=?').all(owner);
    const update = db.prepare('UPDATE account_storage SET value=? WHERE account_id=? AND key=?');
    for (const entry of entries) {
      const key = entry.key as string, previous = entry.value as string;
      const current = sanitize(owner, key, previous);
      if (current !== previous) update.run(current, owner, key);
    }
    return { name: item.n, payload: JSON.stringify(item) };
  }

  function available(owner: string, slot: CharacterSlot) {
    const rows = db.prepare('SELECT id,uid,digest,consumed FROM market_inventory_transfers WHERE owner_id=? AND slot=? AND consumed=0')
      .all(owner, slot) as Approval[];
    if (!rows.length) return [];
    const state = load(owner, slot).state;
    return rows.flatMap(approval => {
      try {
        const item = candidate(state, approval.uid);
        return fingerprint(item) === approval.digest ? [{ id: approval.id, name: item.n, item, legacy: true }] : [];
      } catch { return []; }
    });
  }

  return { approve, check, sanitize, take, available };
}
