import { readFileSync } from 'node:fs';
import { decodeGrid, clearSegment } from '../client/maps/navigation/grid.ts';
import type { GridDefinition, Point, Size } from '../client/maps/types.ts';
import type { BattlefieldTeam } from './battlefield-roster.ts';

const map = JSON.parse(readFileSync(new URL('../client/maps/content/9003/map.json', import.meta.url), 'utf8')) as {
  size: Size;
  navigation: GridDefinition;
};
const layout = JSON.parse(readFileSync(new URL('../client/maps/content/9003/layout.json', import.meta.url), 'utf8')) as {
  camps: Record<BattlefieldTeam, Point>;
};
const grid = decodeGrid(map.navigation, map.size);
const baseSpeed = 150;

export type BattlefieldMove = { x: number; y: number; sequence: number };

export function battlefieldSpawn(team: BattlefieldTeam): Point {
  return { ...layout.camps[team] };
}

export function parseBattlefieldMove(input: unknown): BattlefieldMove | undefined {
  if (input === undefined) return;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const { x, y, sequence } = input as Partial<BattlefieldMove>;
    if (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1 &&
        typeof y === 'number' && Number.isFinite(y) && Math.abs(y) <= 1 &&
        typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0) return { x, y, sequence };
  }
  throw Object.assign(new Error('Hướng di chuyển không hợp lệ.'), { status: 400 });
}

/** Accept direction only. Position, distance budget and map collision stay on the server. */
export function advanceBattlefieldPosition(position: Point, direction: BattlefieldMove, durationMs: number): Point {
  const distance = baseSpeed * Math.max(0, Math.min(250, durationMs)) / 1000;
  const scale = distance / Math.max(1, Math.hypot(direction.x, direction.y));
  const x = position.x + direction.x * scale;
  const y = position.y + direction.y * scale;
  for (const candidate of [{ x, y }, { x, y: position.y }, { x: position.x, y }]) {
    if (clearSegment(grid, position, candidate, true)) return candidate;
  }
  return position;
}
