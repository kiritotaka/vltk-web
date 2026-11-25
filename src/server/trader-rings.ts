import { randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type RingTemplate = { n: string; d: number; mag: number[]; ext?: number[]; grp: number; sid: number; n1?: number; n2?: number };
type Affix = { a: number; p: Array<[number, number]> };

export function createTraderRings(db: DatabaseSync) {
  const row = db.prepare("SELECT data FROM game_data WHERE section='sets' AND entry_key='gold'").get();
  const templates = JSON.parse(row?.data as string || '[]') as RingTemplate[];
  const template = templates.find(item => item.n === 'Càn Khôn Giới Chỉ' && item.d === 3);
  if (!template) throw new Error('Không tìm thấy nhẫn Hoàng Kim trong catalog.');
  const findAffix = db.prepare("SELECT data FROM game_data WHERE section='ge' AND entry_key=?");
  const roll = (id: number) => {
    const source = findAffix.get(String(id));
    if (!source) throw new Error('Không tìm thấy thuộc tính trang bị trong catalog.');
    const affix = JSON.parse(source.data as string) as Affix;
    return { a: affix.a, pre: 1, p: affix.p.map(([first, last]) => {
      if (first === last) return first;
      const top = Math.max(first, last);
      const bottom = Math.max(Math.min(first, last), Math.ceil(top * 0.9));
      return randomInt(bottom, top + 1);
    }) };
  };
  return Array.from({ length: 2 }, () => ({
    ...template, lock: false, r: 4,
    set: { kind: 'gold', grp: template.grp, sid: template.sid, n1: template.n1 || 99, n2: template.n2 || 99 },
    mag: template.mag.map(roll), ext: (template.ext || []).map(roll),
  }));
}
