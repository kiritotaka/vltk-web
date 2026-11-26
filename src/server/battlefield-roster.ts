import { randomUUID } from 'node:crypto';
import { advanceBattlefieldPosition, battlefieldSpawn } from './battlefield-movement.ts';
import type { BattlefieldMove } from './battlefield-movement.ts';

export const battlefieldTeams = ['song', 'jin'] as const;
export type BattlefieldTeam = typeof battlefieldTeams[number];
export const battlefieldTeamCapacity = 100;
const soldierCount = 35;
const battleDurationMs = 20 * 60_000;
const reservationMs = 30_000;

type Participant = {
  id: string;
  team: BattlefieldTeam;
  seat: number;
  expiresAt: number;
  name: string;
  position: { x: number; y: number };
  lastMoveAt: number;
  sequence: number;
};
type Match = {
  id: string;
  startsAt: number;
  endsAt: number;
  players: Map<string, Participant>;
  seats: Record<BattlefieldTeam, Array<Participant | undefined>>;
};

function conflict(message: string): never {
  throw Object.assign(new Error(message), { status: 409 });
}

/** One Hoang Nguyên roster per server. Only the state owner can occupy a human seat. */
export function createBattlefieldRoster(now = Date.now) {
  let match: Match | undefined;

  function remove(current: Match, accountId: string, player: Participant) {
    current.players.delete(accountId);
    current.seats[player.team][player.seat] = undefined;
  }

  function refresh(current: Match, timestamp: number) {
    if (timestamp >= current.endsAt) return;
    for (const [accountId, player] of current.players) {
      if (timestamp >= player.expiresAt) remove(current, accountId, player);
    }
  }

  function snapshot(current: Match, timestamp: number, player?: Participant) {
    const side = (team: BattlefieldTeam) => {
      const occupied = current.seats[team];
      let humans = 0;
      const simSeats = [];
      for (let seat = 0; seat < battlefieldTeamCapacity; seat++) {
        if (occupied[seat]) humans++;
        else simSeats.push(seat);
      }
      return { humans, sims: simSeats.length, simSeats, soldiers: soldierCount };
    };
    return {
      matchId: current.id, startsAt: current.startsAt, endsAt: current.endsAt, serverTime: timestamp,
      finished: timestamp >= current.endsAt,
      actors: [...current.players.values()].map(actor => ({ id: actor.id, team: actor.team, name: actor.name, ...actor.position })),
      teams: { song: side('song'), jin: side('jin') },
      player: player ? { id: player.id, team: player.team, seat: player.seat, movementSequence: player.sequence } : null,
    };
  }

  function join(accountId: string, team: BattlefieldTeam, name = "") {
    const timestamp = now();
    if (team !== 'song' && team !== 'jin') throw Object.assign(new Error('Phe không hợp lệ.'), { status: 400 });
    if (!match || timestamp >= match.endsAt) {
      match = {
        id: randomUUID(), startsAt: timestamp, endsAt: timestamp + battleDurationMs, players: new Map(),
        seats: { song: new Array(battlefieldTeamCapacity), jin: new Array(battlefieldTeamCapacity) },
      };
    }
    refresh(match, timestamp);
    const previous = match.players.get(accountId);
    if (previous) {
      if (previous.team !== team) conflict('Bạn đã tham chiến ở phe khác.');
      previous.expiresAt = timestamp + reservationMs;
      return snapshot(match, timestamp, previous);
    }
    const seat = match.seats[team].findIndex(value => value === undefined);
    if (seat < 0) conflict('Phe này đã đủ 100 người chơi.');
    const player = { id: randomUUID(), seat, team, name, expiresAt: timestamp + reservationMs,
      position: battlefieldSpawn(team), lastMoveAt: timestamp, sequence: 0 };
    match.players.set(accountId, player);
    match.seats[team][seat] = player;
    return snapshot(match, timestamp, player);
  }

  function membership(accountId: string, matchId: string, participantId: string) {
    const timestamp = now();
    if (match?.id !== matchId) conflict('Trận Tống Kim đã kết thúc.');
    refresh(match, timestamp);
    const player = match.players.get(accountId);
    if (!player || player.id !== participantId) conflict('Suất tham gia đã hết hiệu lực.');
    return { current: match, player, timestamp };
  }

  function sync(accountId: string, matchId: string, participantId: string, movement?: BattlefieldMove, applyMove = advanceBattlefieldPosition) {
    const { current, player, timestamp } = membership(accountId, matchId, participantId);
    if (timestamp < current.endsAt) {
      player.expiresAt = timestamp + reservationMs;
      if (movement && movement.sequence > player.sequence) {
        player.position = applyMove(player.position, movement, timestamp - player.lastMoveAt);
        player.lastMoveAt = timestamp;
        player.sequence = movement.sequence;
      }
    }
    return snapshot(current, timestamp, player);
  }

  function leave(accountId: string, matchId: string, participantId: string) {
    const { current, player, timestamp } = membership(accountId, matchId, participantId);
    if (timestamp < current.endsAt) remove(current, accountId, player);
    return snapshot(current, timestamp);
  }

  function active() {
    const timestamp = now();
    if (!match || timestamp >= match.endsAt) return null;
    refresh(match,timestamp);
    return snapshot(match,timestamp);
  }
  return { join, sync, leave, active, reset:()=>{match=undefined;} };
}
