import type { DatabaseSync } from 'node:sqlite';

const SLOT_CAPACITY = 40;
export type CharacterSlot = 'jxidle' | 'jxidle_2' | 'jxidle_3';

export function marketCharacterSlot(value: unknown): CharacterSlot {
  if (value === 'jxidle' || value === 'jxidle_2' || value === 'jxidle_3') return value;
  throw Object.assign(new Error('Hãy chọn ô nhân vật hợp lệ.'), { status: 400 });
}

export function characterInventory(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_character_items (
      item_id TEXT PRIMARY KEY REFERENCES market_items(id),
      slot TEXT NOT NULL CHECK(slot IN ('jxidle','jxidle_2','jxidle_3')),
      payload TEXT NOT NULL CHECK(json_valid(payload))
    ) STRICT;
  `);

  function hasCharacterItem(id: string): boolean {
    return !!db.prepare('SELECT 1 FROM market_character_items WHERE item_id=?').get(id);
  }

  function checkSlot(owner: string, slot: CharacterSlot) {
    if (!db.prepare('SELECT 1 FROM account_storage WHERE account_id=? AND key=?').get(owner, slot))
      throw Object.assign(new Error('Ô này chưa có nhân vật.'), { status: 409 });
  }

  function checkCapacity(owner: string, slot: CharacterSlot) {
    // A listing reserves its seller's slot until purchase, so cancellation
    // can always restore the exact item even if further items are issued.
    const row = db.prepare(`
      SELECT count(*) AS count FROM market_character_items c JOIN market_items i ON i.id=c.item_id
      WHERE i.owner_id=? AND c.slot=? AND i.state IN ('available','escrow')
    `).get(owner, slot);
    if (Number(row?.count) >= SLOT_CAPACITY)
      throw Object.assign(new Error('Hành trang máy chủ của nhân vật đã đầy.'), { status: 409 });
  }

  function available(owner: string, slot: CharacterSlot) {
    checkSlot(owner, slot);
    return db.prepare(`
      SELECT i.id,i.name,c.payload FROM market_character_items c JOIN market_items i ON i.id=c.item_id
      WHERE i.owner_id=? AND c.slot=? AND i.state='available' ORDER BY i.name,i.id
    `).all(owner, slot).map(item => ({ id: item.id, name: item.name, item: JSON.parse(item.payload as string) }));
  }

  function requireSource(id: string, slot?: CharacterSlot) {
    const row = db.prepare('SELECT slot FROM market_character_items WHERE item_id=?').get(id);
    if (row && row.slot !== slot)
      throw Object.assign(new Error('Món này không thuộc Hành trang của nhân vật đang chọn.'), { status: 409 });
  }

  function assign(id: string, owner: string, slot: CharacterSlot) {
    checkSlot(owner, slot);
    checkCapacity(owner, slot);
    db.prepare('UPDATE market_character_items SET slot=? WHERE item_id=?').run(slot, id);
  }

  function catalogItem(index: number) {
    const record = db.prepare("SELECT data FROM game_data WHERE section='sets' AND entry_key='gold'").get();
    const catalog: unknown = record ? JSON.parse(record.data as string) : null;
    const data: unknown = Array.isArray(catalog) && Number.isSafeInteger(index) && index >= 0 ? catalog[index] : undefined;
    const item = data as { n?: string; lvl?: number } | undefined;
    if (typeof item?.n !== 'string' || !item.n || !Number.isSafeInteger(item.lvl))
      throw Object.assign(new Error('Không tìm thấy trang bị trong catalog máy chủ.'), { status: 404 });
    return { name: item.n, payload: JSON.stringify(item) };
  }

  function add(id: string, owner: string, slot: CharacterSlot, payload: string) {
    checkSlot(owner, slot);
    checkCapacity(owner, slot);
    db.prepare('INSERT INTO market_character_items VALUES (?,?,?)').run(id, slot, payload);
  }

  return { hasCharacterItem, available, requireSource, assign, catalogItem, add, checkSlot };
}
