const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('Chiêu Mộ Sứ joins an online room, displays remote actors and restores the field on leaving',async()=>{
  const src=fs.readFileSync('src/client/online/shared-battlefield-01.js','utf8');
  const nodes=new Map(),requests=[];
  let input=[1,0], timestamp=0;
  const originalEnemy={id:'original'},originalGround={name:'Old loot',x:100,y:200};
  function element() {return {children:[],classList:{add(){},toggle(){},contains:()=>true},style:{},append(...nodes){this.children.push(...nodes);},remove(){this.removed=true;}};}
  const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const own={id:'own',kind:'player',name:'Test',team:'song',x:680,y:2784,hp:300,max:300,mana:200,deaths:0,casts:0};
  const enemy={id:'enemy',kind:'player',name:'Other',team:'jin',x:710,y:2784,hp:250,max:250,mana:200,deaths:0,tid:599,faction:'emei',appearance:{sex:1,eq:{}}};
  const snapshot={
    matchId:'shared',player:{id:'own',team:'song',movementSequence:0},teams:{song:{humans:1},jin:{humans:1}},
    combat:{score:{song:0,jin:0},players:[own,enemy]},
  };
  const s={
    window:{localGameAuth:{user:{role:'user'}},localGameStorage:{pending:0,flush:async()=>{}}},
    document:{createElement:element,body:element(),addEventListener(){}},
    m:get, o:{ctrl:'auto',autoMap:true}, v:{x:10,y:20}, l:{town:true,enemies:[originalEnemy],ground:[originalGround]},
    Z0:{key:37}, Y:{}, MapsEngine:{getMapBackground:x=>x}, bA:x=>x, Qv:()=>input, WA:()=>({auto:false}), performance:{now:()=>timestamp},Jt:(fac,sex)=>({anim:fac+sex}),
    ma:id=>{s.Z0.key=id;for(const item of s.l.ground)item.x=400;},n0(){},J(_html,ready){ready?.();}, $(){},y8:()=>'jxidle',
    r0:{599:{anim:'enemy'}},kn:()=>0,AbortSignal,crypto:{randomUUID:()=> 'pharmacy-test'},D:value=>String(value),k:error=>{throw Error(error);},
    async fetch(url,options){
      requests.push([url,JSON.parse(options.body)]);
      return {ok:true,json:async()=>snapshot};
    },
  };
  vm.runInNewContext(src,s);
  s.sharedBattlefield.open();
  get('#shared-war-song').onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.sharedBattlefield.active,true);
  assert.equal(s.Z0.key,9003);
  assert.equal(s.l.enemies[0].id,'enemy');
  assert.equal(s.l.enemies[0].look.anim,'emei1');
  assert.equal(s.l.enemies[0].sharedAvatar,true);
  assert.equal(s.o.ctrl,'auto');
  const renderer={ count:0,update(){ this.count++; return {}; } };
  const view={x:500,y:2400,width:800,height:600};
  s.sharedBattlefield.crowdFrame(renderer,s.l.enemies,.016,view,new Set(),[]);
  s.sharedBattlefield.crowdFrame(renderer,s.l.enemies,.016,view,new Set(),[]);
  assert.equal(renderer.count,1);
  s.sharedBattlefield.crowdFrame(renderer,s.l.enemies,.016,view,new Set([s.l.enemies[0]]),[]);
  assert.equal(renderer.count,2,"selected bodies invalidate the cache");
  s.l.clickedTarget=s.l.enemies[0];
  s.sharedBattlefield.tick(.1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests[1][1].target,'enemy');
  assert.equal(requests[1][1].movement.sequence,1);
  s.sharedBattlefield.usePotion('mana');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(requests[2],['/api/battlefield/shared/pharmacy',{matchId:'shared',participantId:'own',action:'use',resource:'mana',requestId:'pharmacy-test'}]);
  input=[0,0];timestamp=1000;s.l.clickedTarget=null;
  s.sharedBattlefield.tick(.1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests[3][1].target,"enemy","Auto acquires a hostile player without a click");
  const controls=s.document.body.children[0];
  assert.equal(controls.children.length,4);
  controls.children[1].onclick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(s.sharedBattlefield.active,false);
  assert.equal(s.Z0.key,37);
  assert.equal(s.l.enemies[0],originalEnemy);
  assert.equal(s.l.ground[0],originalGround);
  assert.equal(originalGround.x,100);
  assert.equal(s.o.ctrl,'auto');
  assert.equal(s.v.x,10);
});

test('FPS counts drawn frames rather than skipped animation callbacks',()=>{
 const source=fs.readFileSync('src/client/core/game-loop-01.js','utf8');
 const start=source.indexOf('var fpsDrawStarted'), end=source.indexOf('var P_ =',start);
 const label={};
 const s={m:id=>{assert.equal(id,'#gameFps');return label;}};
 vm.runInNewContext(source.slice(start,end),s);
 for(let frame=0;frame<=30;frame++)s.countGameDraw(100+frame*1000/30);
 assert.equal(label.textContent,'30 FPS');
});
