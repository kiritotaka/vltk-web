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
  mounted?:boolean;
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
    ['simulator/equipment.ts', 'ArmyGear'],
    ['simulator/war-mounts.ts', 'WarMounts'],
    ['gameplay/quartermaster/model.ts', 'QuartermasterRules'],
    ['simulator/supplies.ts', 'PharmacyRules'],
  ].map(([file,name])=>new vm.Script(compileTypeScriptEntry(file,name).code,{filename:file})).concat(
    new vm.Script(fs.readFileSync(path.join(ROOT,'src/client/combat/legacy-bridge.js'),'utf8'),{filename:'combat/legacy-bridge.js'}),
  );
}

/** One native contact world per match. Globals are restored after a cast callback. */
export function createBattlefieldCombat(
  onDamage: (source: SharedCombatant, target: SharedCombatant) => void,
  onSupport: (id:number,actor:SharedCombatant,point:{x:number;y:number})=>void = ()=>{},
  random = Math.random,
) {
  const { nativeGlobals: globals, nativeScope: native, vmContext: context } = createNativeProfileScope(ROOT);
  for (const script of getCombatScripts()) script.runInContext(context);
  const { createSupport120, stackSupportPoison, supportDefense, supportLevel } = globals.CombatEngine;
  const support=createSupport120();
  const skillByProfile=new WeakMap<SimulatorProfile,{id:number;level:number}>();
  function supportSkill(profile:SimulatorProfile) {
    let skill=skillByProfile.get(profile);
    if(!skill){
      skill={id:0,level:0};
      for(let id=708;id<=717;id++){
        const level=supportLevel(profile,id);
        if(level){skill={id,level};break;}
      }
      skillByProfile.set(profile,skill);
    }
    return skill;
  }
  const npc=(actor:SharedCombatant)=>actor.kind==="npc" || actor.kind==="marshal";
  const emit=(actor:SharedCombatant)=>(id:number,point:{x:number;y:number})=>onSupport(id,actor,point);
  function updateSupport(actor:SharedCombatant,nearby:()=>SharedCombatant[],time=world.clock) {
    const {id,level}=supportSkill(actor.profile);
    if(!level)return;
    support.update(actor,id,level,actor.hp,actor.max,time,
      ()=>nearby().filter(other=>other.team!==actor.team && npc(other)),emit(actor));
  }
  function periodicDamage(actor:SharedCombatant,damage:number,time:number){
    const {id}=supportSkill(actor.profile);
    return support.immune(actor,id,time) ? 0 : support.shield(actor,id,time,damage);
  }
  const { navigation, size } = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/client/maps/content/9003/map.json'), 'utf8')) as {
    navigation: GridDefinition; size: Size;
  };
  const grid = decodeGrid(navigation, size);
  const sight = (x: number, y: number, tx: number, ty: number) =>
    clearSegment(grid, { x, y }, { x: tx, y: ty }, false);
  const world: LegacyScope = { battlefield: true, quiet: true, serverCombat: true, zoneShown: 9003, clock: 0, fx: [], fxQ: [], life: 1, enemies: [] };
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

  function computerProfile(faction:string, sectSkill=false) {
    const profile = Object.assign(native.I3(), {fac:faction,lvl:150,name:faction,main:"basic",lowFx:true});
    profile.attr.str=400;profile.attr.vit=345;
    if (sectSkill) {
      const skills=(globals.I[faction]?.skills||[]).map((id:number)=>globals.T[id])
        .filter((skill:LegacyScope)=>native.UA(skill) && profile.lvl >= (skill.req||0));
      const selected=skills.find((skill:LegacyScope)=>skill.tier===90) || skills[0];
      if (!selected) throw new Error('Không có võ công tấn công cho SIM '+faction);
      const school=globals.I[faction];
      profile.sex=native.Zt[faction]||0;
      profile.attr={str:0,dex:0,vit:0,eng:0};
      profile.attrPts=(profile.lvl-1)*native.z2;
      const weaponCode=native.j1(selected);
      const weapon=weaponCode===null ? native.Kr(school) : weaponCode===7 ? [1,0] :
        weaponCode>=100 ? [1,weaponCode-100] : [0,weaponCode===-1||weaponCode===9 ? 6 : weaponCode];
      profile.main=selected.id;
      profile.mainLock=true;
      profile.slots=[selected.id];
      for(const skill of skills)if(skill.tier===90 || skill.tier===150){
        const level=Math.min(10,skill.max||10);
        profile.sk[skill.id]=level;
        (profile.skL ||= {})[skill.id]={lv:level,xp:0};
        (profile.bkOk ||= {})[skill.id]=1;
      }
      if(!profile.sk[selected.id]) profile.sk[selected.id]=Math.min(10,selected.max||10);
      const original=globals.o;
      try {
        globals.o=profile;
        profile.eq=globals.ArmyGear.createArmyEquipment(native.equipmentTrader,{
          sex:profile.sex,level:profile.lvl,factionId:school.id,series:school.series,weapon,
          points:profile.attrPts,enh:0,strength:"normal",
        },native.G5,native.V2,globals.Math.random);
        const horse=globals.WarMounts.chooseWarMount(globals.S.items[10]?.list||[],profile.lvl,"random",globals.Math.random);
        if(horse)profile.eq.horse={...horse,d:10,mag:[]};
        native.j5();
        const offense=selected.phys ? "str" : "eng";
        const offensivePoints=Math.floor(profile.attrPts*.6);
        profile.attr[offense]+=offensivePoints;
        profile.attr.vit+=profile.attrPts-offensivePoints;
        profile.attrPts=0;
        if(Object.values(profile.eq).some(item=>!native.p0(item)))throw new Error('SIM chưa đủ điều kiện mặc bộ đồ '+faction);
      } finally {globals.o=original;}
    }
    const stats=statsFor(profile);
    if(sectSkill && stats.main.id!==profile.main) throw new Error('SIM chưa dùng được võ công '+faction);

    return {profile,stats};
  }

  function actorContext<T>(actor: SharedCombatant, action: () => T): T {
    const before = { profile: globals.o, hero: globals.v, stats: world.P, life: world.life, mana: world.mana, mounted:world.mounted };
    Object.assign(globals, { o: actor.profile, v: actor });
    Object.assign(world, { P: actor.stats, life: actor.hp, mana: actor.mana, mounted:!!actor.mounted });
    try { return action(); }
    finally {
      actor.hp = Math.max(0,Math.min(actor.max,world.life));
      actor.mana = Math.max(0,Math.min(actor.stats.mana,world.mana));
      Object.assign(globals, { o: before.profile, v: before.hero });
      Object.assign(world, { P: before.stats, life: before.life, mana: before.mana, mounted:before.mounted });
    }
  }

  let reportedAt=-Infinity;
  function report(error:unknown){
    if(world.clock-reportedAt<5)return;
    reportedAt=world.clock;console.error("Lỗi đòn đánh Tống Kim",error);
  }
  function strike(source: SharedCombatant, target: SharedCombatant, skill: SimulatorSkill, actors:()=>SharedCombatant[]) {
    const time=world.clock;
    const sourceSkill=supportSkill(source.profile), targetSkill=supportSkill(target.profile);
    if(support.fear(source,time))return 0;
    updateSupport(target,actors);
    if(support.evades(target,targetSkill.id,targetSkill.level,time,npc(source),random,emit(target))) return 0;
    if(targetSkill.id===708 && random()*100<supportDefense(targetSkill.level).block){
      onSupport(708,target,target);
      return 0;
    }
    const broken=support.resistance(target,time);
    const res=broken ? {...target.res,phys:(target.res.phys||0)-broken.phys,fire:(target.res.fire||0)-broken.fire} : target.res;
    const receiver = { ...target, res, supportResMax:targetSkill.id===708 ? target.stats.resMaxE : undefined,
      hurtProxy:true, poison: 0, poisonDmg: 0, stun: 0, slowT: 0, slowPower: 0 };
    const fighter = (actor:SharedCombatant) => actor.kind === "player" || actor.kind === "sim";
    const scale = (fighter(source) && fighter(target) ? globals.BattlefieldBalance.BATTLEFIELD_PVP_DAMAGE : 1) *
      support.amplify(source,sourceSkill.id,sourceSkill.level,time);
    const ability = scale === 1 ? skill : {...skill,parts:Object.fromEntries(Object.entries(skill.parts).map(([element,damage])=>[element,damage*scale]))};
    actorContext(source, () => {
      const flat=source.stats.series5;
      try { source.stats.series5=(flat||0)*scale; native.hs(ability,receiver); }
      finally { source.stats.series5=flat; }
    });
    const hit = Math.max(0,target.hp-receiver.hp);
    const resolved = fighter(target) ? globals.SkillDefense.skillDefense(hit,target.stats,target.mana,source.series,native.Jr) : {damage:hit,mana:target.mana};
    const damage=support.shield(target,targetSkill.id,time,resolved.damage);
    const loss=Math.min(target.hp,damage);
    target.hp = Math.max(0,target.hp-damage);
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
    if (!(skill.parts.cold>0)) native.applyActorHurt(target,damage,target.max);
    const procPoison=!skill.ev2 && target.hp>0
      ? support.hit(source,sourceSkill.id,sourceSkill.level,target,npc(target),loss,time,random,emit(source)) : 0;
    if(procPoison>0){
      const seconds=globals.SkillDefense.statusDuration(native.ve,target.stats.poisonRed);
      const cap=Math.max(0,(receiver.supportResMax?.poison ?? 75)-(source.stats.antiMax||0)/4);
      const poison=native.ja(procPoison,"poison",skill.series,target.series,res,cap,skill.series5||0);
      stackSupportPoison(target,poison*seconds/native.ve,seconds);
    }
    const supportReflection=support.reflect(targetSkill.id===709 ? targetSkill.level : 0,npc(source),loss);
    if(supportReflection>0)onSupport(709,target,target);
    const reflected = supportReflection + (fighter(target)
      ? globals.BattlefieldReflection.reflectedSkillDamage(damage,target.stats,skill.melee===false) : 0);
    if (reflected>0) {
      const returned=periodicDamage(source,reflected,time);
      if(returned>0){
        source.hp=Math.max(0,source.hp-returned);
        onDamage(target,source);
      }
    }
    updateSupport(target,actors);
    if (loss > 0 || receiver.poison > 0 || procPoison > 0) onDamage(source,target);
    return damage;
  }

  function inRange(source:SharedCombatant,target:SharedCombatant,skill:SimulatorSkill,closeAttack=false) {
    return globals.CombatEngine.withinSkillCastRange(source,target,skill,closeAttack) as boolean;
  }

  function canReach(source:SharedCombatant,target:SharedCombatant,skill:SimulatorSkill,closeAttack=false) {
    return inRange(source,target,skill,closeAttack) &&
      (native.skillIgnoresTerrain(skill) || sight(source.x,source.y,target.x,target.y));
  }

  function canCastMounted(actor:SharedCombatant,skill:SimulatorSkill) {
    return native.E3(globals.T[Number(skill.id)],!!actor.mounted) as boolean;
  }

  function cast(source: SharedCombatant,target: SharedCombatant,actors: () => SharedCombatant[], skill: SimulatorSkill, onRelease?:()=>void, closeAttack=false) {
    if (source.dead || source.hp <= 0 || source.cooldown > 0 || source.stun > 0 || support.fear(source,world.clock) || native.actorActionLocked(source) ||
        target.dead || target.hp <= 0 || source.team === target.team) return false;
    if(!canCastMounted(source,skill))return false;
    if (!canReach(source,target,skill,closeAttack)) return false;
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
        (ability: SimulatorSkill, defender: SharedCombatant) => strike(source,defender,ability,actors),
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
return { statsFor, computerProfile, cast, advance, potionCatalog, updateSupport, periodicDamage, inRange, canReach, canCastMounted,
  canMount:(actor:SharedCombatant)=>actorContext(actor,()=>!!native.xe()), mountCooldown:native.aP as number,
  resetSupport: support.reset, fear: support.fear,
  supportSpeed(actor:SharedCombatant,time:number){const {id,level}=supportSkill(actor.profile);return support.speed(actor,id,level,time);},
  supportStatus(actor:SharedCombatant,time:number){
    const {id,level}=supportSkill(actor.profile);
    const activeId=id===712 || support.active(actor,time) ? id : 0;
    const feared=!!support.fear(actor,time), cursed=!!support.resistance(actor,time);
    return activeId || feared || cursed ? {id:activeId,speed:support.speed(actor,id,level,time),feared,cursed} : undefined;
  },
  potionCooldown:native.ao as number,
  createPharmacy:globals.PharmacyRules.createWarSupplies as (host:Record<string,unknown>)=>SharedPharmacy,
  recover:globals.CombatEngine.applyPotionRecovery as (state:{life:number;mana:number;P:{life:number;mana:number}},resource:PotionResource,potion:SharedPotion)=>void,
    createWarRewards: globals.WarItemRules.createWarRewards as (host:Record<string,unknown>)=>{use(kind:string):void; apply(stats:SimulatorStats,actor:SharedCombatant):void; tick(dt:number):void; readonly traps:Array<{kind:string;x:number;y:number}>},
    createQuartermaster: globals.QuartermasterRules.createQuartermaster as (host:Record<string,unknown>)=>{quote(kind:string,quantity:number):{before:number;cost:number};buy(kind:string,quantity:number):void},
    prices: globals.QuartermasterRules.WAR_PRICES as Record<string,number>,
    items: globals.WarItemRules.WAR_ITEMS as Record<string,{name:string;icon:string;color:string}>, speed:(actor:SharedCombatant)=>native.actorMovementSpeed(actor) as number, locked: (actor: SharedCombatant) => native.actorActionLocked(actor) as boolean };
}
