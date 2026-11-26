import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createNativeProfileScope } from '../../tools/sim-balance/native-profile-scope.ts';
import type { LegacyScope } from '../../tools/sim-balance/types.ts';
import { decodeGrid, canStandAt, clearSegment } from '../client/maps/navigation/grid.ts';
import type { GridDefinition, Size } from '../client/maps/types.ts';
import type { SimulatorProfile, SimulatorSkill, SimulatorStats } from '../client/simulator/types.ts';
import { ROOT } from './paths.ts';
import type { BattlefieldTeam } from './battlefield-roster.ts';

const require = createRequire(import.meta.url);
const { compileTypeScriptEntry } = require('../../tools/build-app.js') as typeof import('../../tools/build-app.js');

export type PotionResource = "life" | "mana";
export interface SharedPotion { key:string; kind:PotionResource|"both"; tier:number; n:string; ic?:string; total:number; mtotal?:number; price:number }
export interface SharedPharmacy {
  reset(initial:boolean):void; buy(key:string,quantity:number):void; refill():void;
  use(resource:PotionResource):boolean; select(resource:PotionResource,key:string):void;
  catalog():SharedPotion[];
  slot(resource:PotionResource):{ic:string;n:number;name:string};
  readonly state:{life:number;mana:number;total:number;capacity:number;nearCamp:boolean;selected:Record<PotionResource,string>;inventory:Record<string,number>};
}

export interface SharedCombatant {
  id: string;
  kind: "player" | "sim" | "npc" | "marshal";
  team: BattlefieldTeam;
  profile: SimulatorProfile;
  stats: SimulatorStats;
  x: number;
  y: number;
  hp: number;
  max: number;
  mana: number;
  def: number;
  res: Record<string, number>;
  series: number;
  stun: number;
  poison: number;
  poisonDmg: number;
  slowT: number;
  slowPower: number;
  cooldown: number;
  actionRevision: number;
  dead?: boolean;
  tid?: number;
  r: number;
}

let combatScripts: vm.Script[] | undefined;
function getCombatScripts() {
  return combatScripts ??= [
    ['combat/index.ts', 'CombatEngine'],
    ['simulator/skill-cast.ts', 'SkillCast'],
    ['simulator/defense.ts', 'SkillDefense'],
    ['simulator/balance.ts', 'BattlefieldBalance'],
    ['simulator/reflection.ts', 'BattlefieldReflection'],
    ['simulator/war-rewards.ts', 'WarItemRules'],
    ['gameplay/quartermaster/model.ts', 'QuartermasterRules'],
    ['simulator/supplies.ts', 'PharmacyRules'],
  ].map(([file,name])=>new vm.Script(compileTypeScriptEntry(file,name).code,{filename:file})).concat(
    new vm.Script(fs.readFileSync(path.join(ROOT,'src/client/combat/legacy-bridge.js'),'utf8'),{filename:'combat/legacy-bridge.js'}),
  );
}

/** One native contact world per match. Globals are restored after a cast callback. */
export function createBattlefieldCombat(onDamage: (source: SharedCombatant, target: SharedCombatant) => void) {
  const { nativeGlobals: globals, nativeScope: native, vmContext: context } = createNativeProfileScope(ROOT);
  for (const script of getCombatScripts()) script.runInContext(context);
  const { navigation, size } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/client/maps/content/9003/map.json'), 'utf8')) as {
    navigation: GridDefinition; size: Size;
  };
  const grid = decodeGrid(navigation, size);
  const sight = (x: number, y: number, tx: number, ty: number) =>
    clearSegment(grid, { x, y }, { x: tx, y: ty }, false);
  const world: LegacyScope = { battlefield: true, quiet: true, zoneShown: 9003, clock: 0, fx: [], fxQ: [], life: 1, enemies: [] };
  const spectator = { x: -1000, y: -1000 };
  Object.assign(globals, {
    performance: { now:() => world.clock*1000 }, A0: globals.JFX, Z0: { g: true }, l: world, v: spectator,
    mt: sight, R2: (x: number,y: number) => canStandAt(grid,x,y), showDamageNumber() {}, Tt() {}, W3() {}, G8() {},
    r0: { 0: { anim: '' } }, ea: () => 1,
  });

  function statsFor(profile: SimulatorProfile, apply?: (stats: SimulatorStats)=>void): SimulatorStats {
    const previous = globals.o, simulator=globals.arenaSimulator;
    try {
      globals.o = structuredClone(profile);
      if(apply)globals.arenaSimulator={applyBattlefieldBonuses:apply};
      return structuredClone(native.j0()) as SimulatorStats;
    } finally { globals.o = previous;globals.arenaSimulator=simulator; }
  }

  function computerProfile(faction:string) {
    const profile = Object.assign(native.I3(), {fac:faction,lvl:150,name:faction,main:"basic",lowFx:true});
    profile.attr.str=400;profile.attr.vit=345;
    const stats=statsFor(profile);
    return {profile,stats};
  }

  function actorContext<T>(actor: SharedCombatant, action: () => T): T {
    const before = { profile: globals.o, hero: globals.v, stats: world.P, life: world.life, mana: world.mana };
    Object.assign(globals, { o: actor.profile, v: actor });
    Object.assign(world, { P: actor.stats, life: actor.hp, mana: actor.mana });
    try { return action(); }
    finally {
      actor.hp = Math.max(0,Math.min(actor.max,world.life));
      actor.mana = Math.max(0,Math.min(actor.stats.mana,world.mana));
      Object.assign(globals, { o: before.profile, v: before.hero });
      Object.assign(world, { P: before.stats, life: before.life, mana: before.mana });
    }
  }

  let reportedAt=-Infinity;
  function report(error:unknown){
    if(world.clock-reportedAt<5)return;
    reportedAt=world.clock;console.error("Lỗi đòn đánh Tống Kim",error);
  }
  function strike(source: SharedCombatant, target: SharedCombatant, skill: SimulatorSkill) {
    const receiver = { ...target, hurtProxy:true, poison: 0, poisonDmg: 0, stun: 0, slowT: 0, slowPower: 0 };
    const fighter = (actor:SharedCombatant) => actor.kind === "player" || actor.kind === "sim";
    const scale = fighter(source) && fighter(target) ? globals.BattlefieldBalance.BATTLEFIELD_PVP_DAMAGE : 1;
    const ability = scale === 1 ? skill : {...skill,parts:Object.fromEntries(Object.entries(skill.parts).map(([element,damage])=>[element,damage*scale]))};
    actorContext(source, () => {
      const flat=source.stats.series5;
      try { source.stats.series5=(flat||0)*scale; native.hs(ability,receiver); }
      finally { source.stats.series5=flat; }
    });
    const hit = Math.max(0,target.hp-receiver.hp);
    const resolved = fighter(target) ? globals.SkillDefense.skillDefense(hit,target.stats,target.mana,source.series,native.Jr) : {damage:hit,mana:target.mana};
    target.hp = Math.max(0,target.hp-resolved.damage);
    target.mana = resolved.mana;
    if (receiver.poison > 0) {
      const seconds = globals.SkillDefense.statusDuration(receiver.poison,target.stats.poisonRed);
      if (seconds > .05) {
        const remaining = target.poison * target.poisonDmg + receiver.poisonDmg * seconds;
        target.poison = Math.max(seconds,target.poison);
        target.poisonDmg = remaining / target.poison;
      }
    }
    if (receiver.slowT > 0) {
      const seconds = globals.SkillDefense.statusDuration(receiver.slowT,target.stats.freezeRed);
      if (seconds >= target.slowT) {
        target.slowT = seconds;
        target.slowPower = receiver.slowPower;
      }
    }
    target.stun = Math.max(target.stun,globals.SkillDefense.statusDuration(receiver.stun,target.stats.stunRed));
    if (!(skill.parts.cold>0)) native.applyActorHurt(target,resolved.damage,target.max);
    const reflected = fighter(target) ? globals.BattlefieldReflection.reflectedSkillDamage(resolved.damage,target.stats,skill.melee===false) : 0;
    if (reflected>0) {
      source.hp = Math.max(0,source.hp-reflected);
      onDamage(target,source);
    }
    if (resolved.damage > 0 || receiver.poison > 0) onDamage(source,target);
    return resolved.damage as number;
  }

  function cast(source: SharedCombatant,target: SharedCombatant,actors: () => SharedCombatant[], skill: SimulatorSkill, onRelease?:()=>void) {
    if (source.dead || source.hp <= 0 || source.cooldown > 0 || source.stun > 0 || native.actorActionLocked(source) ||
        target.dead || target.hp <= 0 || source.team === target.team) return false;
    const reach = skill.geo?.k === 'self' ? skill.geo.r || skill.rad : skill.rad;
    if (native.skillCastDistance(source,target) > reach + (target.r || 12) ||
        (!native.skillIgnoresTerrain(skill) && !sight(source.x,source.y,target.x,target.y))) return false;
    const cost = skill.cost || 0;
    if (skill.costLife ? source.hp <= cost : source.mana < cost) return false;
    if (skill.costLife) source.hp -= cost;
    else source.mana -= cost;
    source.cooldown = Math.max(native.actorAttackTiming(source,skill).cycleSeconds,skill.cd || 0);
    const revision = source.actionRevision;
    const valid = () => !source.dead && source.hp > 0 && source.actionRevision === revision;
    const targets = () => actors().filter(candidate => candidate.team !== source.team && !candidate.dead && candidate.hp > 0);
    try {
      globals.SkillCast.castSimulatorSkill(source,target,skill,valid,targets,
        (ability: SimulatorSkill, defender: SharedCombatant) => strike(source,defender,ability),
        <T>(action: () => T) => actorContext(source,action),onRelease);
      return true;
    } catch(error) {
      source.actionRevision++;source.cooldown=Math.max(1,source.cooldown);report(error);return false;
    }
  }

  function advance(dt: number) {
    world.clock += dt;
    try { globals.CombatEngine.advanceSkillContacts(dt); }
    catch(error){world.combatProjectiles=[];world.fx=[];world.fxQ=[];report(error);}
  }
  function potionCatalog(level:number):SharedPotion[]{
  return (globals.S.potions || []).filter((potion:SharedPotion)=>level>=(native.be[potion.tier]||999))
    .map((potion:SharedPotion)=>({...potion,key:potion.kind+":"+potion.tier,price:native.Ot(potion)}));
}
return { statsFor, computerProfile, cast, advance, potionCatalog,
  potionCooldown:native.ao as number,
  createPharmacy:globals.PharmacyRules.createWarSupplies as (host:Record<string,unknown>)=>SharedPharmacy,
  recover:globals.CombatEngine.applyPotionRecovery as (state:{life:number;mana:number;P:{life:number;mana:number}},resource:PotionResource,potion:SharedPotion)=>void,
    createWarRewards: globals.WarItemRules.createWarRewards as (host:Record<string,unknown>)=>{use(kind:string):void; apply(stats:SimulatorStats,actor:SharedCombatant):void; tick(dt:number):void; readonly traps:Array<{kind:string;x:number;y:number}>},
    createQuartermaster: globals.QuartermasterRules.createQuartermaster as (host:Record<string,unknown>)=>{quote(kind:string,quantity:number):{before:number;cost:number};buy(kind:string,quantity:number):void},
    prices: globals.QuartermasterRules.WAR_PRICES as Record<string,number>,
    items: globals.WarItemRules.WAR_ITEMS as Record<string,{name:string;icon:string;color:string}>, speed:(actor:SharedCombatant)=>native.actorMovementSpeed(actor) as number, locked: (actor: SharedCombatant) => native.actorActionLocked(actor) as boolean };
}
