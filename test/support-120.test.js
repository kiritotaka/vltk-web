
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {compileTypeScriptEntry}=require('../tools/build-app.js');
const {createNativeProfileScope}=require('../tools/sim-balance/native-profile-scope.ts');
const {createBattlefieldCombat}=require('../src/server/battlefield-combat.ts');

const compiled=compileTypeScriptEntry('combat/index.ts').code;
const engine=vm.runInNewContext(compiled+'\nCombatEngine');
const profile=(fac,id,level=20)=>({fac,lvl:120,sk:{[id]:level}});
const point=(hp=100,x=0,y=0)=>({hp,x,y});
const never=()=>.999, always=()=>0;
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,actual+' != '+expected);

test('all ten skills are gated by learned level, character level and school',()=>{
  const schools=['tianwang','shaolin','tangmen','wudu','emei','cuiyan','gaibang','tianren','wudang','kunlun'];
  for(const [index,school] of schools.entries()){
    const id=index+708;
    assert.equal(engine.supportLevel(profile(school,id,25),id),20);
    assert.equal(engine.supportLevel({...profile(school,id),lvl:119},id),0);
    assert.equal(engine.supportLevel(profile(schools[(index+1)%schools.length],id),id),0);
    assert.equal(engine.supportLevel(profile(school,id,0),id),0);
  }
  assert.deepEqual({...engine.supportDefense(20)},{res:10,cap:5,regen:100,block:12});
  assert.equal(engine.supportBonus(profile('emei',712),{f:'emei'},'buff'),5);
  assert.equal(engine.supportBonus(profile('emei',712),{f:'emei'},'atk'),0);
  assert.equal(engine.supportBonus(profile('emei',712),{f:'emei',tier:120},'passive'),0);
  assert.equal(engine.supportBonus(profile('emei',712),{f:'wudang'},'buff'),0);
});

test('reflection, illusion, poison and resistance curse use documented damage, odds and cooldown',()=>{
  const rules=engine.createSupport120(), owner=point(), target=point(), effects=[];
  const emit=(id,where)=>effects.push([id,where]);
  const update=(id,time)=>rules.update(owner,id,20,100,100,time,()=>[],emit);
  assert.equal(rules.reflect(20,true,80),32);
  assert.equal(rules.reflect(20,false,80),0);
  update(710,0);
  assert.equal(rules.amplify(owner,710,20,5.99),1.6);
  assert.equal(rules.amplify(owner,710,20,6),1);
  assert.equal(rules.evades(owner,710,20,7,false,()=>.24,emit),true);
  assert.equal(rules.evades(owner,710,20,7,false,()=>.25,emit),false);
  update(710,14);assert.equal(rules.active(owner,14),false);
  update(710,15);assert.equal(rules.active(owner,15),true);

  const poisons=engine.createSupport120();
  assert.equal(poisons.hit(owner,711,20,target,true,200,0,()=>.15,emit),0);
  assert.equal(poisons.hit(owner,711,20,target,true,200,0,()=>.149,emit),170);
  assert.equal(poisons.hit(owner,711,20,target,true,200,9.99,always,emit),0);
  assert.equal(poisons.hit(owner,711,20,target,true,200,10,always,emit),170);
  engine.stackSupportPoison(target,170,3);
  engine.stackSupportPoison(target,30,1);
  close(target.poisonDmg*target.poison,200);

  const curses=engine.createSupport120();
  assert.equal(curses.hit(owner,714,20,target,false,100,5,always,emit),0);
  assert.equal(curses.resistance(target,5),null);
  curses.hit(owner,714,20,target,true,100,5,always,emit);
  assert.deepEqual({...curses.resistance(target,13.99)},{phys:10,fire:15});
  assert.equal(curses.resistance(target,14),null);
  curses.hit(owner,714,20,target,true,100,16.99,always,emit);
  assert.equal(curses.resistance(target,17),null);
  curses.hit(owner,714,20,target,true,100,17,always,emit);
  assert.ok(curses.resistance(target,17));
  assert.ok(effects.some(([id,where])=>id===711 && where===target));
});

test('stealth, fear, immunity and shield use strict thresholds, duration and persistent cooldown',()=>{
  const owner=point(), enemies=[point(100,50),point(100,100),point(100,150),point(100,151),point(0,10)];
  const update=(rules,id,hp,time,list=enemies)=>rules.update(owner,id,20,hp,100,time,()=>list,()=>{});
  const stealth=engine.createSupport120();
  update(stealth,713,50,0);assert.equal(stealth.active(owner,0),false);
  update(stealth,713,49,0);assert.equal(stealth.active(owner,29.99),true);
  assert.equal(stealth.evades(owner,713,20,29,true,never,()=>{}),true);
  assert.equal(stealth.evades(owner,713,20,29,false,never,()=>{}),false);
  update(stealth,713,49,39.99);assert.equal(stealth.active(owner,39.99),false);
  update(stealth,713,49,40);assert.equal(stealth.active(owner,40),true);

  const fear=engine.createSupport120();
  update(fear,715,100,0,enemies.slice(0,2));assert.equal(fear.fear(enemies[0],0),undefined);
  update(fear,715,100,1);
  assert.ok(fear.fear(enemies[0],4.99));assert.ok(fear.fear(enemies[2],1));
  assert.equal(fear.fear(enemies[3],1),undefined);assert.equal(fear.fear(enemies[0],5),undefined);
  update(fear,715,39,21,enemies.slice(0,1));assert.ok(fear.fear(enemies[0],21));

  const immunity=engine.createSupport120();
  update(immunity,716,35,0);assert.equal(immunity.immune(owner,716,0),false);
  update(immunity,716,34,0);assert.equal(immunity.evades(owner,716,20,2.99,false,never,()=>{}),true);
  assert.equal(immunity.immune(owner,716,3),false);
  immunity.reset(owner);update(immunity,716,34,4);assert.equal(immunity.immune(owner,716,4),false);
  update(immunity,716,34,15);assert.equal(immunity.immune(owner,716,15),true);

  const shield=engine.createSupport120();
  update(shield,717,30,0);assert.equal(shield.shield(owner,717,0,22),22);
  update(shield,717,29,0);
  assert.equal(shield.shield(owner,717,0,22),0);
  assert.equal(shield.shield(owner,717,1,23),5);
  assert.equal(shield.speed(owner,717,20,9.99),1.35);
  assert.equal(shield.speed(owner,717,20,10),1);
});

function nativeGame(fac,id){
  const {nativeScope:s,nativeGlobals:g,vmContext:c}=createNativeProfileScope(process.cwd());
  vm.runInContext(compiled,c);
  const o=Object.assign(s.I3(),{fac,lvl:120,main:'basic'});
  Object.assign(g,{o,A0:g.JFX,Z0:{g:false},showDamageNumber(){},Tt(){},W3(){},ea:()=>1,
    Math:Object.assign(Object.create(Math),{random:()=>.5})});
  const base=s.j0();
  if(id)o.sk[id]=20;
  const stats=s.j0();
  const v=point(100,0);
  Object.assign(g,{v,l:{P:stats,life:stats.life,mana:stats.mana,fx:[],enemies:[],clock:0}});
  return {s,g,base,stats,v};
}

test('outside-map native attributes and support bars apply level-120 bonuses',()=>{
  const {base,stats}=nativeGame('tianwang',708);
  assert.equal(stats.resMax,base.resMax+5);
  assert.equal(stats.res.fire,base.res.fire+10);
  close(stats.regen-base.regen,stats.life/100);
  const emei=nativeGame('emei',712);
  const skill=Object.values(emei.g.T).find(item=>item.f==='emei' && emei.s.wn(item)==='buff');
  assert.ok(skill);
  emei.g.o.sk[skill.id]=5;
  emei.g.l.P=emei.s.j0();
  assert.equal(emei.g.l.P.skAdd[skill.id],5);
  assert.equal(emei.s.zi(skill.id),10);
});

test('outside-map monster damage uses reflection and a depleted shield',()=>{
  for(const [fac,id] of [['shaolin',709],['kunlun',717]]){
    const {s,g,stats}=nativeGame(fac,id);
    g.l.life=id===717?stats.life*.29:stats.life;
    const monster={x:25,y:0,hp:1000,max:1000,ar:1e9,dmg:Math.min(100,stats.life*.15),series:stats.series,ranged:true};
    const life=g.l.life;
    s.U9(monster);
    if(id===709){
      assert.ok(g.l.life<life);
      close(1000-monster.hp,(life-g.l.life)*.4);
    }else{
      assert.equal(g.l.life,life);
      assert.equal(s.field120Status(),717);
      for(let i=0;i<5;i++)s.U9(monster);
      assert.ok(g.l.life<life);
    }
    assert.ok(g.l.fx.length);
  }
});

test('authoritative Tống Kim applies conditional immunity to ticks and shield to damage and movement',()=>{
  const effects=[];
  const combat=createBattlefieldCombat(()=>{},(id,actor)=>effects.push([id,actor.id]),always);
  function fighter(fac,id,hp){
    const stats={life:100,mana:100};
    return {...point(hp,680,2784),id:String(id),kind:'player',team:'song',profile:profile(fac,id),stats,max:100};
  }
  const immune=fighter('wudang',716,34);
  combat.updateSupport(immune,()=>[],1);
  assert.equal(combat.periodicDamage(immune,20,3.9),0);
  assert.equal(combat.periodicDamage(immune,20,4),20);
  const shield=fighter('kunlun',717,29);
  combat.updateSupport(shield,()=>[],1);
  assert.equal(combat.periodicDamage(shield,25,1),0);
  assert.equal(combat.periodicDamage(shield,30,2),15);
  assert.equal(combat.supportSpeed(shield,10),1.35);
  assert.equal(combat.supportSpeed(shield,11),1);
  assert.deepEqual(effects,[[716,'716'],[717,'717']]);
});


test('Hấp Tinh Yểm adds its poison once to a real outside-map hit',()=>{
  const {s,g,stats}=nativeGame('wudu',711);
  g.Math.random=()=>0;
  const target={...point(1000,40),max:1000,tid:0,def:0,series:stats.series,
    res:{phys:0,fire:0,cold:0,light:0,poison:0}};
  g.r0={0:{anim:''}};
  const skill={...stats.basic,parts:{phys:100},useAR:false,crit:0,series5:0};
  const hit=s.hs(skill,target);
  assert.ok(hit>0);
  close(target.poison*target.poisonDmg,hit*.85);
  const poison=target.poison*target.poisonDmg;
  s.hs(skill,target);
  close(target.poison*target.poisonDmg,poison);
  assert.ok(g.l.fx.some(effect=>effect.k==='ring'));
});

test('Tống Kim authoritative cast attaches Hấp Tinh Yểm damage and a network visual to contact',()=>{
  const effects=[], hits=[];
  const combat=createBattlefieldCombat((source,target)=>hits.push([source.id,target.id]),(id,actor)=>effects.push([id,actor.id]),always);
  const {nativeScope:s}=createNativeProfileScope(process.cwd());
  function actor(id,fac,team,kind,x){
    const saved=Object.assign(s.I3(),{fac,lvl:120,main:'basic'});
    if(fac==='wudu')saved.sk[711]=20;
    const stats=combat.statsFor(saved);
    return {...point(5000,x,2784),id,kind,team,profile:saved,stats,def:0,max:5000,
      series:stats.series,res:{phys:0,fire:0,cold:0,light:0,poison:0},mana:stats.mana,
      stun:0,poison:0,poisonDmg:0,slowT:0,slowPower:0,cooldown:0,actionRevision:0,r:16,tid:0};
  }
  const source=actor('caster','wudu','song','player',680), target=actor('npc','tangmen','jin','npc',725);
  const skill={...source.stats.basic,parts:{phys:100},useAR:false,crit:0,stun:0,series5:0,rad:100};
  assert.equal(combat.cast(source,target,()=>[source,target],skill),true);
  for(let i=0;i<120 && !hits.length;i++)combat.advance(1/60);
  assert.ok(target.hp<5000);
  close(target.poison*target.poisonDmg,(5000-target.hp)*.85);
  assert.deepEqual(hits,[['caster','npc']]);
  assert.deepEqual(effects,[[711,'caster']]);
});
