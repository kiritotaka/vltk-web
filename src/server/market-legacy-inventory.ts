import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CharacterSlot } from './market-character-inventory.ts';

type Item = { uid: number; n: string; d: number; lock?: boolean; ktc?: unknown };
type State = { inv?: unknown[]; [key: string]: unknown };
type Change = { slot: CharacterSlot; unit: 'gold' | 'knb'; delta: number } |
  { slot: CharacterSlot; add: Item[] } | { slot: CharacterSlot; remove: number } | { slot: CharacterSlot; warMerit: number } | { slot: CharacterSlot; warGoods: Record<string,number>; warCost?: number };
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

export function itemForChat(db: DatabaseSync, owner: string, slot: CharacterSlot, uid: number) {
  const row = db.prepare('SELECT value FROM account_storage WHERE account_id=? AND key=?').get(owner, slot);
  const state = typeof row?.value === 'string' ? decode(row.value)?.state : undefined;
  const inventory = Array.isArray(state?.inv) ? state.inv : [];
  const equipped = state?.eq && typeof state.eq === 'object' ? Object.values(state.eq) : [];
  const matching = [...inventory, ...equipped].filter(value => value && typeof value === 'object' && (value as Item).uid === uid);
  const item = matching.length === 1 ? matching[0] as Record<string, unknown> : null;
  if (!item || typeof item.n !== 'string' || !item.n.trim() || item.n.length > 100 ||
      typeof item.d !== 'number' || !Number.isInteger(item.d) || item.d < 0 || item.d > 99) {
    error('Không tìm thấy vật phẩm này trong Hành trang hoặc trang bị của nhân vật.');
  }
  const fields = ['n','d','k','p','r','ic','lvl','s','base','req','mag','ext','set','enh','ktc','lock'];
  const summary = Object.fromEntries(fields.filter(field => Object.hasOwn(item, field)).map(field => [field, item[field]]));
  if (JSON.stringify(summary).length > 6000) error('Thông tin vật phẩm quá dài.');
  return summary;
}

function eligibleEquipment(value: unknown, allowLocked: boolean): value is Item {
  if (!value || typeof value !== 'object') return false;
  const item = value as Item;
  return (allowLocked || !item.lock) && !item.ktc && Number.isInteger(item.d) && item.d >= 0 && item.d <= 9 &&
    typeof item.n === 'string' && !!item.n.trim() && item.n.length <= 100;
}

function candidate(state: State, uid: number, allowLocked = false): Item {
  const found = (state.inv ?? []).filter(item => item && typeof item === 'object' && (item as Item).uid === uid);
  const item = found[0] as Item | undefined;
  if (found.length !== 1 || !eligibleEquipment(item, allowLocked)) {
    error('Món đồ không ở Hành trang, đang khóa hoặc không thuộc loại trang bị có thể chuyển.');
  }
  return item;
}

const historicalFingerprint = (item: Item) => createHash('sha256').update(JSON.stringify(item)).digest('hex');
function fingerprint(item: Item) {
  const { lock, ...details } = item;
  return 'v2:' + createHash('sha256').update(JSON.stringify(details)).digest('hex');
}
const matches = (item: Item, digest: string) =>
  digest === (digest.startsWith('v2:') ? fingerprint(item) : historicalFingerprint(item));

function strip(state: State, ids: Set<number>, digests: Set<string>): boolean {
  let changed = false;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Item;
    if (Number.isSafeInteger(item.uid) && typeof item.n === 'string' &&
      (ids.has(item.uid) || digests.has(fingerprint(item)) || digests.has(historicalFingerprint(item)))) return true;
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
    CREATE TABLE IF NOT EXISTS market_character_updates (
      owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      before TEXT NOT NULL, after TEXT NOT NULL, change TEXT NOT NULL,
      PRIMARY KEY(owner_id,before)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS market_inventory_baselines (
      owner_id TEXT PRIMARY KEY REFERENCES accounts(id),
      item_count INTEGER NOT NULL
    ) STRICT;
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
      if (!result.consumed && matches(item, result.digest)) return result.id;
      error('Mã vật phẩm đã được dùng hoặc món đã thay đổi.');
    }
    const id = randomUUID();
    db.prepare('INSERT INTO market_inventory_transfers(id,owner_id,slot,uid,digest) VALUES (?,?,?,?,?)')
      .run(id, owner, slot, uid, digest);
    return id;
  }

  function recordUpdate(owner: string, change: Change) {
    const before = db.prepare('SELECT generation FROM accounts WHERE id=?').get(owner)!.generation as string;
    const after = randomUUID();
    db.prepare('INSERT INTO market_character_updates VALUES (?,?,?,?)').run(owner, before, after, JSON.stringify(change));
    db.prepare('UPDATE accounts SET generation=? WHERE id=?').run(after, owner);
  }

  function updates(owner: string, since: string) {
    const epoch = db.prepare("SELECT value FROM metadata WHERE key='generation'").get()!.value;
    const current = db.prepare('SELECT generation FROM accounts WHERE id=?').get(owner)!.generation;
    const generation = epoch + ':' + String(current);
    const changes: Change[] = [];
    let cursor = since.startsWith(epoch + ':') ? since.slice(String(epoch).length + 1) : '';
    const next = db.prepare('SELECT after,change FROM market_character_updates WHERE owner_id=? AND before=?');
    while (cursor && cursor !== current) {
      const row = next.get(owner, cursor);
      if (!row) break;
      changes.push(JSON.parse(row.change as string));
      cursor = row.after as string;
    }
    return { generation, changes: cursor === current ? changes : null };
  }

  function addWarMerit(owner:string, slot:CharacterSlot, points:number) {
    if (!Number.isSafeInteger(points) || points<=0) error("Điểm quân trạng không hợp lệ.");
    const save=load(owner,slot);
    const mats=(save.state.mats ??= {}) as Record<string,unknown>;
    const misc=(mats.misc ??= {}) as Record<string,number>;
    const before=Number.isSafeInteger(misc.tk_merit) && misc.tk_merit>0 ? misc.tk_merit : 0;
    if (!Number.isSafeInteger(before+points)) error("Quân trạng vượt giới hạn lưu trữ.");
    misc.tk_merit=before+points;
    db.prepare("UPDATE account_storage SET value=? WHERE account_id=? AND key=?").run(save.encode(),owner,slot);
    recordUpdate(owner,{slot,warMerit:points});
  }

  function addWarGoods(owner:string,slot:CharacterSlot,goods:Record<string,number>,warCost=0) {
    const save=load(owner,slot);
    const mats=(save.state.mats ??= {}) as Record<string,unknown>;
    const misc=(mats.misc ??= {}) as Record<string,number>;
    if (!Number.isSafeInteger(warCost) || warCost<0) error("Giá quân trạng không hợp lệ.");
    if (warCost) {
      const balance=Number.isSafeInteger(misc.tk_merit) ? misc.tk_merit : 0;
      if (balance<warCost) error("Không đủ quân trạng tích lũy.");
      misc.tk_merit=balance-warCost;
    }
    for(const [kind,amount] of Object.entries(goods)){
      if(!/^[a-zA-Z]+$/.test(kind)||!Number.isSafeInteger(amount)||amount===0)error("Vật phẩm Tống Kim không hợp lệ.");
      const key="tk_"+kind,before=Number.isSafeInteger(misc[key])&&misc[key]>0?misc[key]:0;
      if(!Number.isSafeInteger(before+amount)||before+amount<0)error("Số lượng vật phẩm không đủ hoặc vượt giới hạn.");
      misc[key]=before+amount;
    }
    db.prepare("UPDATE account_storage SET value=? WHERE account_id=? AND key=?").run(save.encode(),owner,slot);
    recordUpdate(owner,{slot,warGoods:goods,warCost});
  }

  function changeBalance(owner: string, slot: CharacterSlot, unit: 'gold' | 'knb', delta: number) {
    const save = load(owner, slot);
    const amount = Number(save.state[unit] ?? 0);
    const next = amount + delta;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(next))
      error('Số dư nhân vật không hợp lệ.');
    if (next < 0) error(unit === 'knb' ? 'Hành trang không đủ KNB.' : 'Hành trang không đủ lượng.');
    save.state[unit] = next;
    db.prepare('UPDATE account_storage SET value=? WHERE account_id=? AND key=?').run(save.encode(), owner, slot);
    recordUpdate(owner, { slot, unit, delta });
  }

  function receiveTrustedEquipment(owner: string, slot: CharacterSlot, equipment: Omit<Item, 'uid'>[]) {
    const save = load(owner, slot);
    const inventory = save.state.inv as Item[];
    const expansion = Math.max(0, Math.min(3, Number(save.state.invX) | 0));
    if (inventory.length + equipment.length > 60 + 60 * expansion) error('Hành trang không đủ chỗ.');
    const next = Number(save.state.uid);
    if (!Number.isSafeInteger(next) || next < 1 || next > Number.MAX_SAFE_INTEGER - equipment.length)
      error('Bộ đếm vật phẩm trong save không hợp lệ.');
    const registered = db.prepare('SELECT uid FROM market_inventory_transfers WHERE owner_id=? AND slot=?').all(owner, slot);
    const used = new Set([...inventory.map(item => item?.uid), ...registered.map(row => Number(row.uid))]);
    for (let uid = next; uid < next + equipment.length; uid++) {
      if (used.has(uid)) error('Mã vật phẩm đang được sử dụng. Hãy tải lại Hành trang.');
    }
    for (const [index, item] of equipment.entries()) {
      inventory.push({ ...item, uid: next + index });
    }
    save.state.uid = next + equipment.length;
    db.prepare('UPDATE account_storage SET value=? WHERE account_id=? AND key=?').run(save.encode(), owner, slot);
    for (let uid = next; uid < next + equipment.length; uid++) approve(owner, slot, uid);
    recordUpdate(owner, { slot, add: inventory.slice(-equipment.length) });
  }

  function syncEquipment(owner: string, key: string, value: string) {
    if (key !== 'jxidle' && key !== 'jxidle_2' && key !== 'jxidle_3') return;
    const state = decode(value)?.state;
    if (!state || !Array.isArray(state.inv)) return;

    const upsert = db.prepare(`
      INSERT INTO market_inventory_transfers(id,owner_id,slot,uid,digest) VALUES (?,?,?,?,?)
      ON CONFLICT(owner_id,slot,uid) DO UPDATE SET digest=excluded.digest
      WHERE consumed=0 AND digest<>excluded.digest
    `);
    const inventory = new Map<number, Item | null>();
    for (const entry of state.inv as Array<Item | null>) {
      const uid = entry?.uid;
      if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 1 || uid === Number.MAX_SAFE_INTEGER) continue;
      inventory.set(uid, !inventory.has(uid) && eligibleEquipment(entry, true) ? entry : null);
    }
    for (const [uid, item] of inventory) {
      if (item) upsert.run(randomUUID(), owner, key, uid, fingerprint(item));
    }
  }

  function baseline(owner: string) {
    const previous = db.prepare('SELECT item_count FROM market_inventory_baselines WHERE owner_id=?').get(owner);
    if (previous) return { alreadyRecorded: true, count: Number(previous.item_count) };

    const saves = db.prepare("SELECT key FROM account_storage WHERE account_id=? AND key IN ('jxidle','jxidle_2','jxidle_3')").all(owner);
    if (!saves.length) error('Tài khoản chưa có nhân vật để ghi nhận.');
    const insert = db.prepare(`
      INSERT INTO market_inventory_transfers(id,owner_id,slot,uid,digest) VALUES (?,?,?,?,?)
      ON CONFLICT(owner_id,slot,uid) DO NOTHING
    `);
    let count = 0;
    for (const row of saves) {
      const slot = row.key as CharacterSlot;
      const { state } = load(owner, slot);
      for (const entry of state.inv as Array<Item | null>) {
        const uid = entry?.uid;
        if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 1 || uid === Number.MAX_SAFE_INTEGER) continue;
        let item: Item;
        try { item = candidate(state, uid, true); }
        catch { continue; }
        count += Number(insert.run(randomUUID(), owner, slot, uid, fingerprint(item)).changes);
      }
    }
    db.prepare('INSERT INTO market_inventory_baselines VALUES (?,?)').run(owner, count);
    return { alreadyRecorded: false, count };
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
    if (!matches(item, approval.digest)) error('Món đã thay đổi kể từ lúc được máy chủ xác nhận.');
    db.prepare('UPDATE market_inventory_transfers SET consumed=1 WHERE id=?').run(approval.id);
    const entries = db.prepare('SELECT key,value FROM account_storage WHERE account_id=?').all(owner);
    const update = db.prepare('UPDATE account_storage SET value=? WHERE account_id=? AND key=?');
    for (const entry of entries) {
      const key = entry.key as string, previous = entry.value as string;
      const current = sanitize(owner, key, previous);
      if (current !== previous) update.run(current, owner, key);
    }
    recordUpdate(owner, { slot, remove: approval.uid });
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
        return matches(item, approval.digest) ? [{ id: approval.id, name: item.n, item, legacy: true }] : [];
      } catch { return []; }
    });
  }

  return { approve, baseline, check, sanitize, take, available, receiveTrustedEquipment, syncEquipment, changeBalance, updates, addWarMerit, addWarGoods };
}
