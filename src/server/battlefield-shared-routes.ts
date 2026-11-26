import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { SimulatorProfile } from '../client/simulator/types.ts';
import { createBattlefieldRoster } from './battlefield-roster.ts';
import { createBattlefieldFight } from './battlefield-fight.ts';
import { parseBattlefieldMove } from './battlefield-movement.ts';
import { parseJsonBody, sendJson } from './http.ts';
import { legacyMarketInventory } from './market-legacy-inventory.ts';
import type { CharacterSlot } from './market-character-inventory.ts';

const slots = new Set(['jxidle','jxidle_2','jxidle_3']);
const stepSeconds = 1 / 30;
function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

export function registerSharedBattlefield(
  app: FastifyInstance, db: DatabaseSync, requireUser: (request: FastifyRequest) => { id: string }, now = Date.now, populate = true,
) {
  const roster = createBattlefieldRoster(now);
  const inventory = legacyMarketInventory(db);
  const recipients = new Map<string,{accountId:string;slot:CharacterSlot;pending:number;goods:Record<string,number>}>();
  let nextSettlement = 0;
  function earn(id:string,points:number) {
    const recipient = recipients.get(id);
    if (recipient) recipient.pending+=points;
  }
  function collect(id:string,kind:string) {
    const recipient=recipients.get(id);
    if(recipient)recipient.goods[kind]=(recipient.goods[kind]||0)+1;
  }
  function settle() {
    const credits=[...recipients.values()].filter(recipient=>recipient.pending>0 || Object.keys(recipient.goods).length);
    if(!credits.length)return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for(const credit of credits){
        if(credit.pending>0) inventory.addWarMerit(credit.accountId,credit.slot,credit.pending);
        if(Object.keys(credit.goods).length) inventory.addWarGoods(credit.accountId,credit.slot,credit.goods);
      }
      db.exec("COMMIT");
      for (const credit of credits) { credit.pending=0; credit.goods={}; }
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
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
        if (now()>=nextSettlement) {
          nextSettlement=now()+1000;
          try { settle(); } catch(error) { console.error("Không ghi được quân trạng Tống Kim",error); }
        }
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
    app.addHook("onClose",async()=>{clearInterval(timer);settle();});
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
      if (room.matchId !== current?.id) {
        settle();recipients.clear();
        current = { id:room.matchId, fight:createBattlefieldFight(earn,collect), time:now(), endsAt:room.endsAt, rosterKey:"", armyAt:0 };
      }
      current.fight.join(room.player.id,team,character);
      if(!recipients.has(room.player.id)) recipients.set(room.player.id,{accountId:id,slot:slot as CharacterSlot,pending:0,goods:{}});
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
    if (now !== Date.now) { advance(room.endsAt);settle(); }
    if (!room.finished && skill !== undefined) current.fight.selectSkill(participantId,skill as number | null);
    if (!room.finished && target !== undefined) current.fight.chooseTarget(participantId,target as string | null);
    return sendJson(reply,200,output(room));
  });

  app.post('/api/battlefield/shared/leave', (request,reply) => {
    const { id } = requireUser(request);
    const { matchId, participantId } = command(request);
    if (typeof matchId !== 'string' || typeof participantId !== 'string') return invalid('Mã trận hoặc mã tham gia không hợp lệ.');
    const room = roster.leave(id,matchId,participantId);
    settle();
    if (current?.id === matchId) current.fight.leave(participantId);
    return sendJson(reply,200,output(room));
  });
}
