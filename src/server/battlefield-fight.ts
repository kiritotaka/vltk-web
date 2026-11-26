import { createBattlefieldCombat } from './battlefield-combat.ts';
import type { SharedCombatant } from './battlefield-combat.ts';
import { readFileSync } from 'node:fs';
import { advanceBattlefieldPosition, battlefieldSpawn } from './battlefield-movement.ts';
import type { BattlefieldMove } from "./battlefield-movement.ts";
import type { BattlefieldTeam } from './battlefield-roster.ts';
import type { SimulatorProfile } from '../client/simulator/types.ts';

const killPoints = 150;
const rankThresholds = [0,3000,9000,18000,30000];
const attributionSeconds = 15;
type Point = { x:number; y:number };
const layout = JSON.parse(readFileSync(new URL("../client/maps/content/9003/layout.json", import.meta.url),"utf8")) as {
  armySpawns: Record<BattlefieldTeam,Point[]>; marshals: Record<BattlefieldTeam,Point>;
  patrolPoints: Point[]; paths: [number,number][][];
};
const npcRanks = [
  { name:"Binh sĩ", count:25, life:50000, tid:599, points:50 },
  { name:"Hiệu úy", count:5, life:60000, tid:601, points:100 },
  { name:"Thống lĩnh", count:3, life:80000, tid:608, points:150 },
  { name:"Phó tướng", count:2, life:100000, tid:610, points:200 },
];
const factions = ["shaolin","tianwang","tangmen","wudu","emei","cuiyan","gaibang","tianren","wudang","kunlun"];

interface Player extends SharedCombatant {
  deaths: number;
  points: number;
  requestedTarget: string | null;
  skillId: number | null;
  casts:number;
  kind: "player" | "sim" | "npc" | "marshal";
  home: Point; reward: number; returnAt: number; route: number; waypoint: number;
}

export function createBattlefieldFight(earned?: (id:string,points:number)=>void, collected?: (id:string,kind:string)=>void, random=Math.random) {
  const players = new Map<string, Player>();
  const score: Record<BattlefieldTeam,number> = { song: 0, jin: 0 };
  const latestHit = new Map<string, { player: Player; time: number }>();
  let time = 0, nextSearch = 0, nextDropCheck=0, dropId=0;
  const drops: Array<Point & {id:number;kind:string; team:BattlefieldTeam; until:number}> = [];
  const aiProfiles = new Map<string,{profile:SimulatorProfile;stats:SharedCombatant["stats"]}>();

  function respawn(player: Player) {
    if (player.hp > 0 || player.dead) return;
    const hit = latestHit.get(player.id);
    if (hit && time-hit.time <= attributionSeconds) {
      const rank = rankThresholds.findLastIndex(threshold=>player.points>=threshold)+1;
      const merit = player.kind === "player" || player.kind === "sim" ? player.reward*rank : player.reward;
      score[hit.player.team] += merit;
      hit.player.points += merit;
      if (hit.player.kind === "player") earned?.(hit.player.id,merit);
      if (player.kind === "npc" && random() < .35) {
        const kinds=Object.keys(combat.items);
        if(drops.length>=40)drops.shift();
        drops.push({id:++dropId,x:player.x,y:player.y,team:hit.player.team,kind:kinds[Math.floor(random()*kinds.length)],until:time+90});
      }
    }
    latestHit.delete(player.id);
    if (player.kind !== "player") {
      player.dead = true; player.actionRevision++;
      player.returnAt = player.kind === "marshal" ? Infinity : time + (player.kind === "sim" ? 30 : 20);
      return;
    }
    restore(player);
  }

  function restore(player:Player) {
    Object.assign(player, player.home, {
      dead:false, waypoint:0,
      hp:player.max, mana:player.stats.mana, cooldown:0, requestedTarget:null,
      stun:0, poison:0, poisonDmg:0, slowT:0, slowPower:0, castT:0, hurtT:0,
      deaths:player.deaths+1, actionRevision:player.actionRevision+1,
    });
  }

  const combat = createBattlefieldCombat((source,target) => {
    const attacker = players.get(source.id), defender = players.get(target.id);
    if (!attacker || !defender || attacker.team === defender.team) return;
    latestHit.set(defender.id,{ player:attacker,time });
    respawn(defender);
  });

  function join(id:string, team:BattlefieldTeam, profile:SimulatorProfile) {
    if (players.has(id)) return;
    const stats = combat.statsFor(profile);
    if (!(Number.isFinite(stats.life) && stats.life > 0 && Number.isFinite(stats.mana) && stats.mana >= 0 &&
      Number.isFinite(stats.main.rad) && stats.main.rad > 0)) throw new Error('Chỉ số nhân vật không hợp lệ.');
    add(id,team,profile,stats,"player",battlefieldSpawn(team),killPoints,0);
  }

  function add(id:string,team:BattlefieldTeam,profile:SimulatorProfile,stats:SharedCombatant["stats"],kind:Player["kind"],home:Point,reward:number,tid:number) {
    players.set(id,{
      id,team,profile,stats,...home,home,kind,reward,returnAt:Infinity,route:0,waypoint:0,hp:stats.life,max:stats.life,mana:stats.mana,
      def:stats.def,res:stats.res,series:stats.series,deaths:0,points:0,actionRevision:0,cooldown:0,
      stun:0,poison:0,poisonDmg:0,slowT:0,slowPower:0,requestedTarget:null,skillId:null,casts:0,r:15,tid,
    });
  }

  function leave(id: string) {
    const player = players.get(id);
    if (!player) return;
    player.dead = true;
    player.actionRevision++;
    players.delete(id);
    latestHit.delete(id);
  }

  function chooseTarget(id:string,targetId:string|null) {
    const source = players.get(id);
    const opponent = targetId && players.get(targetId);
    if (!source || (targetId && (!opponent || source.team === opponent.team))) return false;
    source.requestedTarget = targetId;
    return true;
  }

  function move(id:string,x:number,y:number) {
    const player = players.get(id);
    if (!player || player.stun>0 || combat.locked(player)) return false;
    Object.assign(player,{x,y});
    return true;
  }

  function army(sims:Record<BattlefieldTeam,number[]>) {
    const desired = new Set<string>();
    for (const team of ["song","jin"] as const) {
      for (const seat of sims[team]) {
        const id = team + "-sim-" + seat;
        desired.add(id);
        if (!players.has(id)) {
          const faction = factions[seat % factions.length];
          const profile = computerProfile(faction);
          const home = layout.armySpawns[team][seat % layout.armySpawns[team].length];
          add(id,team,{...profile.profile,name:"SIM " + (seat+1)},profile.stats,"sim",home,150,599);
          players.get(id)!.route = seat % layout.paths.length;
        }
      }
      if (time >= 5) {
        let ordinal = 0;
        for (const rank of npcRanks) for (let index=0; index<rank.count; index++) {
          const id = team + "-npc-" + ordinal;
          const point = layout.patrolPoints[ordinal++ % layout.patrolPoints.length];
          const home = team === "song" ? point : {x:3584-point.x,y:3584-point.y};
          if (!players.has(id)) {
            const profile = computerProfile("shaolin");
            add(id,team,{...profile.profile,name:rank.name},{...profile.stats,life:rank.life},"npc",home,rank.points,rank.tid);
          }
        }
      }
      if (time >= 600 && !players.has(team+"-marshal")) {
        const profile = computerProfile(team === "song" ? "gaibang" : "emei");
        add(team+"-marshal",team,{...profile.profile,name:"Nguyên soái"},{...profile.stats,life:200000},"marshal",layout.marshals[team],1000,599);
      }
    }
    for (const actor of players.values()) if (actor.kind === "sim" && !desired.has(actor.id)) leave(actor.id);
  }

  function computerProfile(faction:string) {
    let entry = aiProfiles.get(faction);
    if (!entry) {
      entry = combat.computerProfile(faction);
      aiProfiles.set(faction,entry);
    }
    return entry;
  }

  const actors = () => [...players.values()];
  function updateTargets() {
    const bins = new Map<string,Player[]>();
    const cell = (x:number) => Math.floor(x/320);
    for (const actor of players.values()) {
      if (actor.dead) continue;
      const key = cell(actor.x)+":"+cell(actor.y);
      let bucket = bins.get(key);
      if (!bucket) { bucket = []; bins.set(key,bucket); }
      bucket.push(actor);
    }
    for (const actor of players.values()) {
      if (actor.dead || actor.kind === "player") continue;
      const x=cell(actor.x), y=cell(actor.y);
      let distance=420**2, nearest:Player|undefined;
      for (let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++) {
        for (const other of bins.get((x+dx)+":"+(y+dy)) || []) {
          if (other.team === actor.team) continue;
          const gap=(other.x-actor.x)**2+4*(other.y-actor.y)**2;
          if (gap<distance) { distance=gap;nearest=other; }
        }
      }
      actor.requestedTarget=nearest?.id||null;
    }
  }
  function moveComputer(player:Player,target:Player|undefined,dt:number) {
    if (player.kind === "marshal" || player.stun > 0 || combat.locked(player)) return;
    let destination:Point|undefined = target;
    if (player.kind === "npc") {
      if (!target || Math.hypot(player.x-player.home.x,player.y-player.home.y)>800) destination=player.home;
    } else if (!destination) {
      const path=layout.paths[player.route];
      const point=path[player.team === "song" ? player.waypoint : path.length-1-player.waypoint];
      if (!point) return;
      destination={x:point[0],y:point[1]};
      if (Math.hypot(destination.x-player.x,destination.y-player.y)<12) player.waypoint++;
    }
    if (!destination) return;
    const x=destination.x-player.x,y=destination.y-player.y;
    const scale=Math.max(Math.hypot(x,y),15);
    Object.assign(player,advanceBattlefieldPosition(player,{x:x/scale,y:y/scale,sequence:1},1000*dt));
  }
  function tick(dt:number) {
    time += dt;
    if (time >= nextSearch) { updateTargets(); nextSearch=time+.25; }
    for (const player of players.values()) {
      if (player.dead) { if (time>=player.returnAt) restore(player); else continue; }
      player.cooldown = Math.max(0,player.cooldown-dt);
      player.stun = Math.max(0,player.stun-dt);
      player.slowT = Math.max(0,player.slowT-dt);
      if (player.poison > 0) {
        const duration = Math.min(player.poison,dt);
        player.poison -= duration;
        player.hp = Math.max(0,player.hp-duration*player.poisonDmg);
        if (player.hp <= 0) { respawn(player); continue; }
      }
      player.hp = Math.min(player.max,player.hp + (player.stats.regen || 0)*dt);
      player.mana = Math.min(player.stats.mana,player.mana + (player.stats.manaRegen || 0)*dt);
      const target = player.requestedTarget ? players.get(player.requestedTarget) : undefined;
      let cast = false;
      if (target && !target.dead) {
        const main = player.skillId === 0 ? player.stats.basic : player.stats.actives?.find((entry:SharedCombatant["stats"]["main"])=>entry.id===player.skillId) || player.stats.main;
        const skill = (!main.costLife && player.mana < (main.cost || 0)) ? player.stats.basic : main;
        cast = combat.cast(player,target,actors,skill);
        if (cast) player.casts++;
      }
      if (!cast && player.kind !== "player" && (!target || target.dead || Math.hypot(target.x-player.x,(target.y-player.y)*2)>player.stats.main.rad)) moveComputer(player,target?.dead?undefined:target,dt);
    }
    combat.advance(dt);
    if(time>=nextDropCheck){collectNearby();nextDropCheck=time+.1;}
  }

  function pruneHumans(active:Set<string>) {
    for (const actor of players.values()) if (actor.kind==="player" && !active.has(actor.id)) leave(actor.id);
  }
  function moveInput(id:string,direction:BattlefieldMove,elapsed:number) {
    const actor=players.get(id);
    if (!actor) return undefined;
    if (actor.stun<=0 && !combat.locked(actor)) {
      const speed=combat.speed(actor);
      const point=advanceBattlefieldPosition(actor,direction,elapsed,Number.isFinite(speed)?Math.min(3,speed):1);
      Object.assign(actor,point);
    }
    return {x:actor.x,y:actor.y};
  }
  function selectSkill(id:string,skillId:number|null) {
    const actor=players.get(id);
    if (!actor) return;
    if (skillId === null || skillId === 0 || actor.stats.actives?.some((skill:SharedCombatant["stats"]["main"])=>skill.id===skillId)) actor.skillId=skillId;
  }
  function collectNearby() {
    for(let index=drops.length-1;index>=0;index--){
      const drop=drops[index];
      if(drop.until<=time){drops.splice(index,1);continue;}
      for(const player of players.values()){
        if(player.kind!=="player"||player.team!==drop.team||player.hp<=0||Math.hypot(player.x-drop.x,(player.y-drop.y)*2)>80)continue;
        const inventory=player.profile.mats?.misc ?? {};
        const stock=Math.max(0,Number(inventory["tk_"+drop.kind])||0);
        const warSlots=Object.keys(combat.items).reduce((count,kind)=>count+Math.ceil((Number(inventory["tk_"+kind])||0)/50),0);
        const capacity=60+60*Math.max(0,Math.min(3,Number(player.profile.invX)||0));
        const specialSlots=["vlmt","ttk","rngua","ldt"].filter(kind=>Number(inventory[kind])>0).length;
        if(stock%50===0 && player.profile.inv.length+warSlots+specialSlots>=capacity)continue;
        player.profile.mats??={};player.profile.mats.misc??={};
        player.profile.mats.misc["tk_"+drop.kind]=stock+1;
        collected?.(player.id,drop.kind);
        drops.splice(index,1);break;
      }
    }
  }
  function snapshot(viewerId?:string) {
    const viewer = viewerId ? players.get(viewerId) : undefined;
    const visible = (actor:Player) => actor.kind === "player" || !viewer || Math.abs(actor.x-viewer.x)<=1100 && Math.abs(actor.y-viewer.y)<=720;
    return {
      score:{...score},
      drops:viewer ? drops.filter(drop=>drop.team===viewer.team && Math.abs(drop.x-viewer.x)<=1100 && Math.abs(drop.y-viewer.y)<=720)
        .map(drop=>({id:drop.id,x:drop.x,y:drop.y,...combat.items[drop.kind]})) : [],
      players:actors().filter(visible).map(player=>({
        id:player.id, team:player.team, name:player.profile.name, x:player.x, y:player.y, hp:player.hp, max:player.max,
        mana:player.mana, deaths:player.deaths, points:player.points, faction:player.profile.fac, kind:player.kind, tid:player.tid, dead:!!player.dead, casts:player.casts,
      })),
    };
  }
  return { join,leave,chooseTarget,move,tick,snapshot,army,pruneHumans,moveInput,selectSkill };
}
