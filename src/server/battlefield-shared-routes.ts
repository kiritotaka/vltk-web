import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { SimulatorProfile } from '../client/simulator/types.ts';
import { createBattlefieldRoster } from './battlefield-roster.ts';
import { createBattlefieldFight } from './battlefield-fight.ts';
import { parseBattlefieldMove } from './battlefield-movement.ts';
import { parseJsonBody, sendJson } from './http.ts';

const slots = new Set(['jxidle','jxidle_2','jxidle_3']);
const stepSeconds = 1 / 30;
function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export function registerSharedBattlefield(
  app: FastifyInstance, db: DatabaseSync, requireUser: (request: FastifyRequest) => { id: string }, now = Date.now, populate = true,
) {
  const roster = createBattlefieldRoster(now);
  const select = db.prepare('SELECT value FROM account_storage WHERE account_id=? AND key=?');
  let current: { id:string; fight:ReturnType<typeof createBattlefieldFight>; time:number; endsAt:number; rosterKey:string; armyAt:number } | undefined;
  function advance(endsAt: number) {
    if (!current) return;
    const deadline=Math.min(now(),endsAt);
    current.time=Math.max(current.time,deadline-250);
    let remaining = (deadline-current.time)/1000;
    while (remaining >= stepSeconds - 1e-9) {
      current.fight.tick(stepSeconds);
      current.time += stepSeconds * 1000;
      remaining -= stepSeconds;
    }
  }

  function command(request: FastifyRequest): Record<string, unknown> {
    const body = parseJsonBody(request.body);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('Yêu cầu Tống Kim không hợp lệ.');
    return body as Record<string, unknown>;
  }

  function arrange(room: ReturnType<typeof roster.join>) {
    if (!current || current.id !== room.matchId) return invalid('Trận đấu đã kết thúc.',409);
    const present = room.actors.map(actor=>actor.id);
    const key = present.join(",");
    if (key !== current.rosterKey) current.fight.pruneHumans(new Set(present));
    if (populate && !room.finished && (key !== current.rosterKey || current.time >= current.armyAt)) {
      current.fight.army({song:room.teams.song.simSeats,jin:room.teams.jin.simSeats});
      current.armyAt = current.time+1000;
    }
    current.rosterKey=key;
  }
  function output(room:ReturnType<typeof roster.join>) {
    arrange(room);
    if (!current) return invalid("Trận đấu đã kết thúc.",409);
    return { matchId:room.matchId, startsAt:room.startsAt, endsAt:room.endsAt, serverTime:room.serverTime,
      finished:room.finished, player:room.player, teams:Object.fromEntries(Object.entries(room.teams).map(([team,side])=>
        [team,{humans:side.humans,sims:side.sims,soldiers:side.soldiers}])),
      combat:current.fight.snapshot(room.player?.id) };
  }

  if (now === Date.now) {
    const timer=setInterval(()=>{
      if (!current || current.time >= current.endsAt-1) return;
      try {
        advance(current.endsAt);
        if (current.time>=current.armyAt) {
          const room=roster.active();
          if (room) arrange(room);
        }
      } catch (error) {
        console.error("Tống Kim",error);
        roster.reset();
        current=undefined;
      }
    },1000/30);
    timer.unref();
    app.addHook("onClose",async()=>{clearInterval(timer);});
  }

  app.post('/api/battlefield/shared/join', (request,reply) => {
    const { id } = requireUser(request);
    const { team, slot } = command(request);
    if ((team !== 'song' && team !== 'jin') || typeof slot !== 'string' || !slots.has(slot)) {
      return invalid('Hãy chọn phe và ô nhân vật hợp lệ.');
    }
    let character: SimulatorProfile | undefined;
    try {
      const raw = select.get(id,slot)?.value;
      if (typeof raw === 'string') {
        const envelope = JSON.parse(raw);
        character = typeof envelope?.d === 'string' ? JSON.parse(envelope.d) : envelope;
      }
    } catch { return invalid('Không đọc được dữ liệu nhân vật.',409); }
    if (!character || typeof character.fac !== "string" || typeof character.name !== "string" || !character.name.trim() || !character.attr || !character.eq || !character.sk) {
      return invalid('Hãy lưu nhân vật trước khi vào Tống Kim.',409);
    }
    character.name=character.name.trim().slice(0,48);
    const room = roster.join(id,team,character.name);
    if (!room.player) return invalid('Không lấy được suất tham chiến.',409);
    try {
      if (room.matchId !== current?.id) current = { id:room.matchId, fight:createBattlefieldFight(), time:now(), endsAt:room.endsAt, rosterKey:"", armyAt:0 };
      current.fight.join(room.player.id,team,character);
    } catch (error) {
      roster.leave(id,room.matchId,room.player.id);
      throw error;
    }
    return sendJson(reply,200,output(room));
  });

  app.post('/api/battlefield/shared/sync', (request,reply) => {
    const { id } = requireUser(request);
    const { matchId, participantId, movement, target, skill } = command(request);
    if (typeof matchId !== 'string' || typeof participantId !== 'string' ||
        (target !== undefined && target !== null && typeof target !== 'string') ||
        (skill !== undefined && skill !== null && (typeof skill !== 'number' || !Number.isSafeInteger(skill) || skill < 0))) {
      return invalid('Mã trận, mục tiêu hoặc mã tham gia không hợp lệ.');
    }
    const room = roster.sync(id,matchId,participantId,parseBattlefieldMove(movement), (previous, direction, elapsed) => {
      return current?.fight.moveInput(participantId,direction,elapsed) ?? previous;
    });
    if (!current || matchId !== current.id) return invalid('Trận đấu đã kết thúc.',409);
    if (now !== Date.now) advance(room.endsAt);
    if (!room.finished && skill !== undefined) current.fight.selectSkill(participantId,skill as number | null);
    if (!room.finished && target !== undefined) current.fight.chooseTarget(participantId,target as string | null);
    return sendJson(reply,200,output(room));
  });

  app.post('/api/battlefield/shared/leave', (request,reply) => {
    const { id } = requireUser(request);
    const { matchId, participantId } = command(request);
    if (typeof matchId !== 'string' || typeof participantId !== 'string') return invalid('Mã trận hoặc mã tham gia không hợp lệ.');
    const room = roster.leave(id,matchId,participantId);
    if (current?.id === matchId) current.fight.leave(participantId);
    return sendJson(reply,200,output(room));
  });
}
