import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { SimulatorProfile } from '../client/simulator/types.ts';
import { battlefieldMatchMs, battlefieldRegistrationMs, battlefieldSchedule } from './battlefield-schedule.ts';
import { battlefieldTeamCapacity, createBattlefieldRoster } from './battlefield-roster.ts';
import type { BattlefieldTeam } from './battlefield-roster.ts';
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
  app: FastifyInstance, db: DatabaseSync, requireUser: (request: FastifyRequest) => { id: string; role?: string }, now = Date.now, populate = true,
) {
  const roster = createBattlefieldRoster(now);
  db.exec(`CREATE TABLE IF NOT EXISTS battlefield_registrations (
    starts_at INTEGER NOT NULL, account_id TEXT NOT NULL, slot TEXT NOT NULL, team TEXT NOT NULL,
    name TEXT NOT NULL, PRIMARY KEY(starts_at, account_id)
  ) STRICT`);
  type Enrollment = {account_id: string; team: BattlefieldTeam; slot:string; name:string};
  const enrollment = db.prepare('SELECT * FROM battlefield_registrations WHERE starts_at=? AND account_id=?');
  const enroll = db.prepare('INSERT INTO battlefield_registrations VALUES (?,?,?,?,?)');
  const enrolled = db.prepare('SELECT * FROM battlefield_registrations WHERE starts_at=?');
  const pruneEnrollments = db.prepare('DELETE FROM battlefield_registrations WHERE starts_at<?');
  const inventory = legacyMarketInventory(db);
  db.exec("CREATE TABLE IF NOT EXISTS battlefield_supply_receipts (account_id TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(account_id,request_id)) STRICT");
  const supplyReceipt=db.prepare("SELECT signature FROM battlefield_supply_receipts WHERE account_id=? AND request_id=?");
  const saveReceipt=db.prepare("INSERT INTO battlefield_supply_receipts VALUES (?,?,?)");
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
  let current: { id:string; fight:ReturnType<typeof createBattlefieldFight>; time:number; endsAt:number; rosterKey:string; armyAt:number; startsAt:number; manual:boolean } | undefined;

  function start(startsAt:number, manual:boolean) {
    settle();
    recipients.clear();
    const room=roster.open(startsAt,battlefieldMatchMs);
    if (!manual) {
      pruneEnrollments.run(startsAt);
      for (const player of enrolled.all(startsAt) as Enrollment[]) roster.join(player.account_id,player.team,player.name);
    }
    current={id:room.matchId,startsAt,manual,endsAt:room.endsAt,time:now(),
      fight:createBattlefieldFight(earn,collect),rosterKey:"",armyAt:0};
    const live=roster.active();
    if(live) arrange(live);
  }

  function ensureScheduled() {
    const {live}=battlefieldSchedule(now());
    if(live!==null && current?.startsAt!==live) start(live,false);
  }

  function teamCounts(room:ReturnType<typeof roster.open>) {
    const {song,jin}=room.teams;
    const count=({humans,sims,soldiers}:typeof song)=>({humans,sims,soldiers});
    return {song:count(song),jin:count(jin)};
  }

  function availability(id:string) {
    ensureScheduled();
    const time=now(), schedule=battlefieldSchedule(time);
    const room=roster.active();
    const slotStart=room && !current?.manual ? room.startsAt : schedule.next;
    const saved=enrollment.get(slotStart,id) as Enrollment | undefined;
    return {phase:room ? 'active' : schedule.registration ? 'registration' : 'waiting',
      manual:room ? current?.manual : false, startsAt:room?.startsAt ?? schedule.next,
      registrationOpen:schedule.registration, nextStart:schedule.next, registrationAt:schedule.next-battlefieldRegistrationMs, endsAt:room?.endsAt ?? null,
      registration:saved ? {team:saved.team,slot:saved.slot} : null, teams:room ? teamCounts(room) : null,
      canOpenManual:!room && !schedule.registration && time+battlefieldMatchMs<=schedule.next};
  }
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
      finished:room.finished, player:room.player, teams:teamCounts(room),
      combat:current.fight.snapshot(room.player?.id) };
  }

  if (now === Date.now) {
    let lastFault=-Infinity;
    const timer=setInterval(()=>{
      try {
        ensureScheduled();
        if (!current) return;
        if (now()<current.endsAt || current.time<current.endsAt-stepSeconds*1000) advance(current.endsAt);
        if (now()>=nextSettlement) {
          nextSettlement=now()+1000;
          try { settle(); } catch(error) { console.error("Không ghi được quân trạng Tống Kim",error); }
        }
        if (now()<current.endsAt && current.time>=current.armyAt) {
          const room=roster.active();
          if (room) arrange(room);
        }
      } catch (error) {
        if(now()-lastFault>=5000){lastFault=now();console.error("Tống Kim",error);}
        // Keep the roster on isolated failures and resume from the next tick.
        if(current)current.time=Math.min(now(),current.endsAt);
      }
    },1000/30);
    timer.unref();
    app.addHook("onClose",async()=>{clearInterval(timer);settle();});
  }

  app.post('/api/battlefield/shared/status', (request,reply) => {
    return sendJson(reply,200,availability(requireUser(request).id));
  });

  app.post('/api/battlefield/shared/manual', (request,reply) => {
    const {id,role}=requireUser(request);
    if(role!=='gm' && role!=='admin') return invalid('Chỉ GM được mở trận chung thủ công.',403);
    if(!availability(id).canOpenManual) return invalid('Đang có trận hoặc sắp đến giờ báo danh.',409);
    start(now(),true);
    return sendJson(reply,200,availability(id));
  });

  function participate(request:FastifyRequest,reply:import('fastify').FastifyReply, registering:boolean) {
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
    ensureScheduled();
    if(registering){
      const schedule=battlefieldSchedule(now());
      if(!schedule.registration) return invalid('Chưa đến giờ báo danh Tống Kim.',409);
      const previous=enrollment.get(schedule.next,id) as Enrollment | undefined;
      if(previous){
        if(previous.team!==team || previous.slot!==slot) return invalid('Bạn đã báo danh bằng nhân vật hoặc phe khác.',409);
      } else {
        const count=(enrolled.all(schedule.next) as Enrollment[]).filter(entry=>entry.team===team).length;
        if(count>=battlefieldTeamCapacity) return invalid('Phe này đã đủ 100 người báo danh.',409);
        enroll.run(schedule.next,id,slot,team,character.name);
      }
      return sendJson(reply,200,availability(id));
    }
    if(!current || !roster.active()) return invalid('Trận chung chưa mở. Hãy báo danh tại Chiêu Mộ Sứ.',409);
    if(!current.manual){
      const entry=enrollment.get(current.startsAt,id) as Enrollment | undefined;
      if(entry?.team!==team || entry.slot!==slot) return invalid('Hãy vào trận bằng đúng nhân vật và phe đã báo danh.',409);
    }
    const room = roster.join(id,team,character.name);
    if (!room.player) return invalid('Không lấy được suất tham chiến.',409);
    try {
      current.fight.join(room.player.id,team,character,id+":"+slot);
      if(!recipients.has(room.player.id)) recipients.set(room.player.id,{accountId:id,slot:slot as CharacterSlot,pending:0,goods:{}});
    } catch (error) {
      roster.leave(id,room.matchId,room.player.id);
      throw error;
    }
    return sendJson(reply,200,output(room));
  }

  app.post('/api/battlefield/shared/register', (request,reply) => participate(request,reply,true));
  app.post('/api/battlefield/shared/join', (request,reply) => participate(request,reply,false));

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

  app.post("/api/battlefield/shared/supplies", (request,reply)=>{
    const {id}=requireUser(request);
    const {matchId,participantId,action,kind,quantity,requestId}=command(request);
    if (typeof matchId!=="string"||typeof participantId!=="string")return invalid("Mã trận không hợp lệ.");
    const room = roster.sync(id,matchId,participantId);
    if (!current || current.id!==matchId || room.finished)return invalid("Trận đấu đã kết thúc.",409);
    if (action===undefined)return sendJson(reply,200,current.fight.supplies(participantId));
    if ((action!=="buy"&&action!=="use")||typeof kind!=="string"||typeof requestId!=="string"||!/^[a-zA-Z0-9-]{1,80}$/.test(requestId)||
        typeof quantity!=="number"||!Number.isSafeInteger(quantity)||quantity<1||quantity>50||(action==="use"&&quantity!==1))return invalid("Yêu cầu quân nhu không hợp lệ.");
    const recipient=recipients.get(participantId);
    if(!recipient || recipient.accountId!==id)return invalid("Suất tham gia đã hết hiệu lực.",409);
    const signature=JSON.stringify([matchId,participantId,action,kind,quantity]);
    const previous=supplyReceipt.get(id,requestId);
    if(previous){
      if(previous.signature!==signature)return invalid("Mã yêu cầu đã được sử dụng.",409);
      return sendJson(reply,200,current.fight.supplies(participantId));
    }
    settle();
    try {
      current.fight.supply(participantId,action,kind,quantity,(delta,cost)=>{
        db.exec("BEGIN IMMEDIATE");
        try {
          inventory.addWarGoods(id,recipient.slot,{[kind]:delta},cost);
          saveReceipt.run(id,requestId,signature);
          db.exec("COMMIT");
        } catch(error){db.exec("ROLLBACK");throw error;}
      });
    } catch(error) {return invalid(error instanceof Error?error.message:"Không xử lý được vật phẩm.",409);}
    return sendJson(reply,200,current.fight.supplies(participantId));
  });

  app.post("/api/battlefield/shared/pharmacy", (request,reply)=>{
    const {id}=requireUser(request);
    const {matchId,participantId,action,key,quantity,resource,requestId}=command(request);
    if(typeof matchId!=="string"||typeof participantId!=="string")return invalid("Mã trận không hợp lệ.");
    const room=roster.sync(id,matchId,participantId);
    if(!current||current.id!==matchId||room.finished)return invalid("Trận đấu đã kết thúc.",409);
    if (action===undefined)return sendJson(reply,200,current.fight.pharmacy(participantId));
    if (action!=="buy"&&action!=="refill"&&action!=="use"&&action!=="select")return invalid("Thao tác Dược Điếm không hợp lệ.");
    if ((action==="buy"||action==="select") && (typeof key!=="string"||key.length>32))return invalid("Loại thuốc không hợp lệ.");
    if (action==="buy" && (typeof quantity!=="number"||!Number.isSafeInteger(quantity)||quantity<1||quantity>60))return invalid("Số lượng thuốc không hợp lệ.");
    if ((action==="use"||action==="select") && resource!=="life"&&resource!=="mana")return invalid("Ô thuốc không hợp lệ.");
    if (action!=="select" && (typeof requestId!=="string"||!/^[a-zA-Z0-9-]{1,80}$/.test(requestId)))return invalid("Mã yêu cầu không hợp lệ.");
    const receiver=recipients.get(participantId);
    if(!receiver||receiver.accountId!==id)return invalid("Suất tham gia đã hết hiệu lực.",409);
    const signature=JSON.stringify(["pharmacy",matchId,participantId,action,key,quantity,resource]);
    const previous=typeof requestId==="string" ? supplyReceipt.get(id,requestId) : undefined;
    if(previous){
      if(previous.signature!==signature)return invalid("Mã yêu cầu đã được sử dụng.",409);
      return sendJson(reply,200,current.fight.pharmacy(participantId));
    }
    try {
      current.fight.pharmacyAction(participantId,action,typeof key==="string"?key:"",typeof quantity==="number"?quantity:0,resource==="mana"?"mana":"life",cost=>{
        if(typeof requestId!=="string")return invalid("Mã yêu cầu không hợp lệ.");
        db.exec("BEGIN IMMEDIATE");
        try {
          if(cost>0)inventory.changeBalance(id,receiver.slot,"gold",-cost);
          saveReceipt.run(id,requestId,signature);
          db.exec("COMMIT");
        } catch(error){db.exec("ROLLBACK");throw error;}
      });
    }catch(error){return invalid(error instanceof Error?error.message:"Không xử lý được thuốc.",409);}
    return sendJson(reply,200,current.fight.pharmacy(participantId));
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
