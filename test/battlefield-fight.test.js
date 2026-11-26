const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBattlefieldFight}=require('../src/server/battlefield-fight.ts');
const {createNativeProfileScope}=require('../tools/sim-balance/native-profile-scope.ts');

test('native shared hit credits the opposing team and respawns the defeated player once',()=>{
  const {nativeScope, nativeGlobals}=createNativeProfileScope(process.cwd());
  const fight=createBattlefieldFight();
  const player = name => Object.assign(nativeScope.I3(), {fac:'wudang',name,lvl:100,main:'basic',potOff:true,lowFx:true});
  const attacker=player('Tống');
  attacker.attr.str=5000;
  const life=nativeGlobals.S.attr.indexOf('lifemax_v');
  attacker.eq={amulet:{d:4,lvl:1,base:[[life,250,250]],req:[],mag:[],s:-1}};
  fight.join('song','song',attacker,'account:slot');
  fight.join('jin','jin',player('Kim'));
  fight.join('ally','song',player('Đồng đội'));
  fight.move('jin',726,2784);
  fight.move('ally',710,2784);
  assert.equal(fight.chooseTarget('song','ally'),false);
  assert.equal(fight.chooseTarget('song','jin'),true);
  let snapshot;
  for(let tick=0;tick<1200;tick++){
    fight.tick(1/60);
    snapshot=fight.snapshot();
    if(snapshot.score.song)break;
  }
  const winner=snapshot.players.find(player=>player.id==='song');
  const loser=snapshot.players.find(player=>player.id==='jin');
  const ally=snapshot.players.find(player=>player.id==='ally');
  assert.equal(winner.max,ally.max+250);
  assert.equal(ally.hp,ally.max);
  assert.equal(snapshot.score.song,150);
  assert.equal(winner.points,150);
  assert.equal(loser.deaths,1);
  assert.equal(loser.hp,loser.max);
  assert.deepEqual([loser.x,loser.y],[2904,800]);
  fight.tick(1);
  assert.equal(fight.snapshot().score.song,150);
  fight.leave('song');
  assert.throws(()=>fight.join('changed-team','jin',attacker,'account:slot'),{status:409});
  fight.join('returned','song',attacker,'account:slot');
  const returned=fight.snapshot();
  assert.equal(returned.score.song,150);
  assert.equal(returned.players.find(actor=>actor.id==='returned').points,150);
});

test('two signed-in SQLite characters share native hits, score and the respawn snapshot',async()=>{
  const Fastify=require('fastify');
  const {registerAccounts}=require('../src/server/accounts.ts');
  const {openDatabase}=require('../src/server/database.ts');
  const {registerSharedBattlefield}=require('../src/server/battlefield-shared-routes.ts');
  const {accountCookie}=require('./helpers/accounts.js');
  const {paths}=require('../src/client/maps/content/9003/layout.json');
  const {nativeScope}=createNativeProfileScope(process.cwd());
  const db=openDatabase(':memory:'),app=Fastify();
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*',{parseAs:'string'},(_req,body,done)=>done(null,body));
  const accounts=registerAccounts(app,db);
  app.post('/test/save',(request,reply)=>{
    accounts.write(request,JSON.parse(request.body));
    return reply.send({saved:true});
  });
  let time=0;
  registerSharedBattlefield(app,db,accounts.requireUser,()=>time,false);
  const post=(cookie,action,data)=>app.inject({method:'POST',url:'/api/battlefield/shared/'+action,headers:{cookie},payload:JSON.stringify(data)});
  try {
    const blue=await accountCookie(app,'shared_tong'), red=await accountCookie(app,'shared_kim');
    for(const [cookie,name,str] of [[blue,'Tống',5000],[red,'Kim',10]]) {
      const profile=Object.assign(nativeScope.I3(),{fac:'wudang',name,lvl:100,main:'basic',potOff:true,lowFx:true});
      profile.attr.str=str;
      const account=db.prepare("SELECT id,generation FROM accounts WHERE username=?").get(name==='Tống'?'shared_tong':'shared_kim');
      const epoch=db.prepare("SELECT value FROM metadata WHERE key='generation'").get().value;
      const saved=await app.inject({method:'POST',url:'/test/save',headers:{cookie},payload:JSON.stringify({
        generation:epoch+':'+account.generation,id:'shared-profile',operations:[{key:'jxidle',value:JSON.stringify(profile)}],
      })});
      assert.equal(saved.statusCode,200,saved.body);
    }
    time=Date.parse('2026-11-26T07:49:59+07:00');
    assert.equal((await post(blue,'register',{team:'song',slot:'jxidle'})).statusCode,409);
    time+=1000;
    assert.equal((await post(blue,'join',{team:'song',slot:'jxidle'})).statusCode,409);
    assert.equal((await post(blue,'register',{team:'song',slot:'jxidle'})).statusCode,200);
    assert.equal((await post(blue,'register',{team:'song',slot:'jxidle'})).statusCode,200);
    assert.equal((await post(blue,'register',{team:'jin',slot:'jxidle'})).statusCode,409);
    time=Date.parse('2026-11-26T08:00:00+07:00');
    const status=(await post(blue,'status',{})).json();
    assert.equal(status.startsAt,time);
    assert.equal(status.endsAt,time+30*60_000);
    assert.equal(status.teams.song.humans,1);
    assert.equal(status.teams.song.sims,99);
    assert.equal(status.teams.song.soldiers,35);
    const beforeLate=(await post(red,'status',{})).json();
    assert.equal(beforeLate.registration,null);
    assert.equal(beforeLate.teams.jin.humans,0);
    const wrongMatch=await post(blue,'join',{team:'song',slot:'jxidle',matchId:'expired-round'});
    assert.equal(wrongMatch.statusCode,409);
    const a=await post(blue,'join',{team:'song',slot:'jxidle'}), b=await post(red,'join',{team:'jin',slot:'jxidle'});
    assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);
    const aRoom=a.json(), bRoom=b.json();
    assert.equal(aRoom.matchId,bRoom.matchId);
    assert.equal(bRoom.teams.jin.humans,1);
    assert.equal(bRoom.teams.jin.sims,99);
    assert.deepEqual((await post(red,'status',{})).json().registration,{team:'jin',slot:'jxidle'});
    assert.equal((await post(red,'join',{team:'song',slot:'jxidle'})).statusCode,409);
    const ref=(room)=>({matchId:room.matchId,participantId:room.player.id});
    const blueRef=ref(aRoom),redRef=ref(bRoom);
    let position=aRoom.combat.players[0], sequence=0;
    for(const point of paths[0].slice(1,-6)) {
      time+=100;
      if(sequence%40===0) await post(red,'sync',redRef);
      const vx=point[0]-position.x,vy=point[1]-position.y;
      const scale=Math.max(15,Math.hypot(vx,vy));
      const reply=await post(blue,'sync',{...blueRef,movement:{x:vx/scale,y:vy/scale,sequence:++sequence}});
      assert.equal(reply.statusCode,200,reply.body);
      position=reply.json().combat.players.find(player=>player.id===blueRef.participantId);
    }
    assert.ok(Math.hypot(position.x-2904,position.y-800)<100,JSON.stringify(position));
    let result;
    for(let index=0;index<100;index++){
      time+=150;
      result=(await post(blue,'sync',{...blueRef,target:redRef.participantId})).json();
      if(result.combat.score.song>0)break;
    }
    assert.equal(result.combat.score.song,150,JSON.stringify(result.combat));
    const seenByRed=(await post(red,'sync',redRef)).json();
    assert.deepEqual(seenByRed.combat.score,result.combat.score);
    const returned=seenByRed.combat.players.find(player=>player.id===redRef.participantId);
    assert.equal(returned.deaths,1); assert.equal(returned.hp,returned.max);
    const owner=db.prepare("SELECT id FROM accounts WHERE username=?").get("shared_tong");
    const merit=()=>JSON.parse(db.prepare("SELECT value FROM account_storage WHERE account_id=? AND key=?").get(owner.id,"jxidle").value).mats.misc.tk_merit;
    assert.equal(merit(),150);
    await post(blue,"sync",blueRef);
    await post(blue,"sync",blueRef);
    assert.equal(merit(),150);
  } finally { await app.close();db.close(); }
});

test('shared battle AI fills both sides and keeps the 35 NPCs during player replacement',()=>{
  const {nativeScope}=createNativeProfileScope(process.cwd());
  const fight=createBattlefieldFight();
  const slots=Array.from({length:100},(_,index)=>index);
  fight.army({song:slots,jin:slots});
  const count=(team,kind)=>fight.snapshot().players.filter(actor=>actor.team===team&&actor.kind===kind).length;
  assert.equal(count('song','sim'),100);
  assert.equal(count('jin','sim'),100);
  for(let tick=0;tick<151;tick++)fight.tick(1/30);
  fight.army({song:slots.slice(1),jin:slots});
  const profile=Object.assign(nativeScope.I3(),{fac:'wudang',name:'Test',lvl:100,main:'basic',potOff:true});
  fight.join('signed-in','song',profile);
  assert.equal(count('song','sim'),99);assert.equal(count('song','player'),1);
  assert.equal(count('song','npc'),35);assert.equal(count('jin','npc'),35);
  fight.leave('signed-in');
  fight.army({song:slots,jin:slots});
  assert.equal(count('song','sim'),100);assert.equal(count('song','npc'),35);
});

test('normal Fastify server runs the shared room with live troop slots',async(t)=>{
  const {createServer}=require('../src/server/index.ts');
  const {openDatabase}=require('../src/server/database.ts');
  const {accountCookie}=require('./helpers/accounts.js');
  const {nativeScope}=createNativeProfileScope(process.cwd());
  t.mock.method(Date,'now',()=>Date.parse('2026-11-26T06:00:00+07:00'));
 const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  const send=(cookie,url,data)=>app.inject({url,headers:{cookie},...(data?{method:'POST',payload:JSON.stringify(data)}:{})});
  try {
    const cookies=[await accountCookie(app,'live_tong'),await accountCookie(app,'live_kim')];
    assert.equal((await send(cookies[0],'/api/battlefield/shared/manual',{})).statusCode,403);
    db.prepare("UPDATE accounts SET role='gm' WHERE username=?").run('live_tong');
    assert.equal((await send(cookies[0],'/api/battlefield/shared/manual',{})).statusCode,200);
    const rooms=[];
    for(const [index,cookie] of cookies.entries()) {
      const saved=await send(cookie,'/api/storage');
      const value=JSON.stringify(Object.assign(nativeScope.I3(),{name:'Live '+index,fac:'wudang',lvl:100,main:'basic',potOff:true}));
      const write=await send(cookie,'/api/storage',{generation:saved.json().generation,id:'on-server',operations:[{key:'jxidle',value}]});
      assert.equal(write.statusCode,200,write.body);
      const joined=await send(cookie,'/api/battlefield/shared/join',{team:index?'jin':'song',slot:'jxidle'});
      assert.equal(joined.statusCode,200,joined.body);
      rooms.push(joined.json());
    }
    assert.equal(rooms[0].matchId,rooms[1].matchId);
    assert.equal(rooms[1].teams.song.sims,99);
    assert.equal(rooms[1].teams.jin.sims,99);
    assert.equal(rooms[1].teams.song.soldiers,35);
    assert.equal(rooms[1].combat.players.filter(actor=>actor.kind==='player').length,2);
    const sim=rooms[1].combat.players.find(actor=>actor.kind==='sim');
    assert.ok(sim?.appearance,"SIM has a humanoid appearance");
    assert.ok(sim.appearance.eq.weapon && sim.appearance.eq.armor && sim.appearance.eq.helm && sim.appearance.eq.horse);
    assert.ok(sim.faction);
    const joined=rooms[1];
    const left=await send(cookies[1],'/api/battlefield/shared/leave',{matchId:joined.matchId,participantId:joined.player.id});
    assert.equal(left.json().teams.jin.sims,100);
    assert.equal(left.json().combat.players.filter(actor=>actor.kind==='player').length,1);
    const resumed=await send(cookies[1],'/api/battlefield/shared/join',{matchId:joined.matchId,team:'jin',slot:'jxidle'});
    assert.equal(resumed.statusCode,200,resumed.body);
    assert.equal(resumed.json().matchId,joined.matchId);
    assert.equal(resumed.json().teams.jin.sims,99);
    assert.ok(resumed.json().combat.players.some(actor=>actor.team==='jin' && actor.kind==='sim'));
  } finally {await app.close();db.close();}
});

test('shared NPC loot belongs to its team and one drop can only be collected once',()=>{
  const {nativeScope}=createNativeProfileScope(process.cwd());
  const delivered=[];
  const fight=createBattlefieldFight(undefined,(id,kind)=>delivered.push([id,kind]),()=>0);
  const profile=Object.assign(nativeScope.I3(),{fac:'wudang',name:'Loot test',lvl:100,main:'basic',potOff:true});
  profile.attr.str=10_000_000;
  fight.join('looter','song',profile);
  for(let n=0;n<151;n++)fight.tick(1/30);
  fight.army({song:[],jin:[]});
  const id='jin-npc-0';
  fight.move(id,720,2784);
  fight.chooseTarget('looter',id);
  for(let n=0;n<150;n++)fight.tick(1/30);
  if (!delivered.length) {
    const found=fight.snapshot('looter').drops;
    assert.ok(found.length,JSON.stringify({score:fight.snapshot().score,actors:fight.snapshot().players.filter(actor=>actor.id===id||actor.id==="looter")}));
    fight.move('looter',found[0].x,found[0].y);
    for(let n=0;n<6;n++)fight.tick(1/30);
  }
  assert.deepEqual(delivered,[['looter','resistance']]);
  assert.equal(fight.snapshot('looter').drops.length,0);
});

test('shared quartermaster prices, supplies and traps use a single durable receipt',async(t)=>{
 const {createServer}=require('../src/server/index.ts');
 const {openDatabase}=require('../src/server/database.ts');
 const {accountCookie}=require('./helpers/accounts.js');
 const {nativeScope}=createNativeProfileScope(process.cwd());
 t.mock.method(Date,'now',()=>Date.parse('2026-11-26T06:00:00+07:00'));
 const db=openDatabase(':memory:'); const {app}=createServer({db,downloadAssets:false});
 try {
  const cookie=await accountCookie(app,'supply_tong');
  db.prepare("UPDATE accounts SET role='gm' WHERE username=?").run('supply_tong');
  const open=await app.inject({method:'POST',url:'/api/battlefield/shared/manual',headers:{cookie},payload:{}});
  assert.equal(open.statusCode,200,open.body);
  const other=await accountCookie(app,'supply_kim');
  const send=(url,data,session=cookie)=>app.inject({url,headers:{cookie:session},...(data?{method:'POST',payload:JSON.stringify(data)}:{})});
  const start=(await send('/api/storage')).json();
  const profile=Object.assign(nativeScope.I3(),{name:'Supply test',fac:'wudang',lvl:100,main:'basic',potOff:true});
  profile.mats.misc={tk_merit:3000,tk_life:1,tk_stunTrap:1};
  assert.equal((await send('/api/storage',{generation:start.generation,id:'supply-save',operations:[{key:'jxidle',value:JSON.stringify(profile)}]})).statusCode,200);
  const joined=(await send('/api/battlefield/shared/join',{team:'song',slot:'jxidle'})).json();
  const ref={matchId:joined.matchId,participantId:joined.player.id};
  const action=(data,session)=>send('/api/battlefield/shared/supplies',{...ref,...data},session);
  assert.equal((await action({},other)).statusCode,409);
  assert.equal((await action({})).json().nearShop,true);
  const buy={action:'buy',kind:'resistance',quantity:10,requestId:'buy-10'};
  db.exec("CREATE TEMP TRIGGER fail_supply BEFORE INSERT ON battlefield_supply_receipts BEGIN SELECT RAISE(ABORT,'forced rollback'); END");
  assert.equal((await action(buy)).statusCode,409);
  assert.equal(JSON.parse((await send('/api/storage')).json().entries.jxidle).mats.misc.tk_merit,3000);
  db.exec('DROP TRIGGER fail_supply');
  assert.equal((await action(buy)).statusCode,200);
  assert.equal((await action(buy)).json().merit,1500);
  assert.equal((await action({...buy,quantity:1})).statusCode,409);
  const life={action:'use',kind:'life',quantity:1,requestId:'use-life'};
  assert.equal((await action(life)).statusCode,200);
  assert.equal((await action(life)).statusCode,200);
  assert.equal((await action({...life,requestId:'use-life-new'})).statusCode,409);
  const trap={action:'use',kind:'stunTrap',quantity:1,requestId:'set-trap'};
  assert.equal((await action(trap)).statusCode,200);
  const updated=(await send('/api/battlefield/shared/sync',ref)).json();
  const player=updated.combat.players.find(actor=>actor.id===ref.participantId);
  assert.equal(player.max,joined.combat.players.find(actor=>actor.id===ref.participantId).max+500);
  assert.equal(updated.combat.traps.length,1);
  const saved=JSON.parse((await send('/api/storage')).json().entries.jxidle).mats.misc;
  assert.deepEqual(saved,{tk_merit:1500,tk_life:0,tk_stunTrap:0,tk_resistance:10});
 } finally {await app.close();db.close();}
});

test('server trap only affects an opposing actor and quartermaster rejects distant purchases',()=>{
 const {nativeScope}=createNativeProfileScope(process.cwd());
 const fight=createBattlefieldFight();
 const profile=name=>Object.assign(nativeScope.I3(),{name,fac:'wudang',lvl:100,main:'basic',potOff:true});
 const a=profile('A');a.mats.misc={tk_stunTrap:1,tk_merit:20000};
 fight.join('A','song',a);fight.join('enemy','jin',profile('Enemy'));fight.join('ally','song',profile('Ally'));
 fight.move('A',690,2784);
 fight.move('enemy',720,2784);
 fight.move('ally',710,2784);
 fight.supply('A','use','stunTrap',1,()=>{});
 for(let step=0;step<4;step++)fight.tick(1/30);
 const snapshot=fight.snapshot('A');
 assert.equal(snapshot.traps.length,0);
 assert.equal(snapshot.players.find(actor=>actor.id==='enemy').stun,true);
 assert.equal(snapshot.players.find(actor=>actor.id==='ally').stun,false);
 fight.move('A',1200,2200);
 assert.throws(()=>fight.supply('A','buy','resistance',1,()=>assert.fail('purchase should not settle')),/Quan Quân Nhu/);
});

test('shared pharmacy buys and consumes potions once and persists only the gold debit',async(t)=>{
 const {createServer}=require('../src/server/index.ts');
 const {openDatabase}=require('../src/server/database.ts');
 const {accountCookie}=require('./helpers/accounts.js');
 const {nativeScope}=createNativeProfileScope(process.cwd());
 t.mock.method(Date,'now',()=>Date.parse('2026-11-26T06:00:00+07:00'));
 const db=openDatabase(':memory:');const {app}=createServer({db,downloadAssets:false});
 try {
  const cookie=await accountCookie(app,'pharmacy_tong');
  db.prepare("UPDATE accounts SET role='gm' WHERE username=?").run('pharmacy_tong');
  const open=await app.inject({method:'POST',url:'/api/battlefield/shared/manual',headers:{cookie},payload:{}});
  assert.equal(open.statusCode,200,open.body);
  const other=await accountCookie(app,'pharmacy_kim');
  const send=(url,data,session=cookie)=>app.inject({url,headers:{cookie:session},...(data?{method:'POST',payload:JSON.stringify(data)}:{})});
  const initial=(await send('/api/storage')).json();
  const profile=Object.assign(nativeScope.I3(),{name:'Potion test',fac:'wudang',lvl:100,main:'basic',potOff:true,gold:800});
  profile.mats.misc={tk_life:1};
  assert.equal((await send('/api/storage',{generation:initial.generation,id:'pharmacy-save',operations:[{key:'jxidle',value:JSON.stringify(profile)}]})).statusCode,200);
  const joined=(await send('/api/battlefield/shared/join',{team:'song',slot:'jxidle'})).json();
  const ref={matchId:joined.matchId,participantId:joined.player.id};
  const pharmacy=(data,session)=>send('/api/battlefield/shared/pharmacy',{...ref,...data},session);
  const gold=async()=>JSON.parse((await send('/api/storage')).json().entries.jxidle).gold;
  const buy={action:'buy',key:'life:1',quantity:1,requestId:'buy-hp'};
  assert.equal((await pharmacy({},other)).statusCode,409);
  assert.equal((await pharmacy({})).json().total,60);
  assert.equal((await pharmacy(buy)).statusCode,409);
  const pill=await send('/api/battlefield/shared/supplies',{...ref,action:'use',kind:'life',quantity:1,requestId:'life-pill'});
  assert.equal(pill.statusCode,200,pill.body);
  const use={action:'use',resource:'life',requestId:'drink-hp'};
  const used=await pharmacy(use);
  assert.equal(used.statusCode,200,used.body);
  assert.equal(used.json().life,29);
  assert.equal((await pharmacy(use)).json().life,29);
  assert.equal((await pharmacy({...use,requestId:'drink-at-full-hp'})).statusCode,409);
  const healed=(await send('/api/battlefield/shared/sync',ref)).json().combat.players.find(actor=>actor.id===ref.participantId);
  assert.equal(healed.hp,healed.max);
  assert.equal((await send("/api/battlefield/shared/leave",ref)).statusCode,200);
  const rejoined=(await send("/api/battlefield/shared/join",{team:"song",slot:"jxidle"})).json();
  assert.equal(rejoined.matchId,ref.matchId);
  ref.participantId=rejoined.player.id;
  assert.equal((await pharmacy({})).json().total,59);
  const savedBefore=(await send('/api/storage')).json();
  db.exec("CREATE TEMP TRIGGER fail_pharmacy BEFORE INSERT ON battlefield_supply_receipts BEGIN SELECT RAISE(ABORT,'forced rollback'); END");
  assert.equal((await pharmacy(buy)).statusCode,409);
  assert.equal(await gold(),800);
  assert.equal((await send('/api/storage')).json().generation,savedBefore.generation);
  assert.equal((await pharmacy({})).json().total,59);
  db.exec('DROP TRIGGER fail_pharmacy');
  assert.equal((await pharmacy(buy)).json().total,60);
  assert.equal((await pharmacy(buy)).json().total,60);
  assert.equal((await pharmacy({...buy,quantity:2})).statusCode,409);
  assert.equal(await gold(),795);
  assert.equal((await pharmacy({action:'select',resource:'life',key:'life:1'})).json().selected.life,'life:1');
  assert.equal((await pharmacy({action:'select',resource:'mana',key:'life:1'})).statusCode,409);
  const updates=await send('/api/market/character-updates?generation='+encodeURIComponent(savedBefore.generation));
  assert.deepEqual(updates.json().changes,[{slot:'jxidle',unit:'gold',delta:-5}]);
 } finally { await app.close();db.close(); }
});

test('daily Vietnam schedule includes the final 23:00 round and rolls over at midnight',()=>{
  const {battlefieldSchedule}=require('../src/server/battlefield-schedule.ts');
  const at=(time)=>Date.parse('2026-11-26T'+time+'+07:00');
  const first=at('08:00:00'),last=at('23:00:00');
  assert.deepEqual(battlefieldSchedule(at('07:49:59')),{live:null,next:first,registration:false});
  assert.deepEqual(battlefieldSchedule(at('07:50:00')),{live:null,next:first,registration:true});
  assert.equal(battlefieldSchedule(first).live,first);
  assert.equal(battlefieldSchedule(at('08:30:00')).live,null);
  assert.deepEqual(battlefieldSchedule(at('22:50:00')),{live:null,next:last,registration:true});
  assert.equal(battlefieldSchedule(last).live,last);
  assert.deepEqual(battlefieldSchedule(at('23:30:00')),{live:null,next:first+86400000,registration:false});
});

test('shared cast enforces the outside-map dismount policy before spending mana',()=>{
  const {createBattlefieldCombat}=require('../src/server/battlefield-combat.ts');
  const {nativeScope:s}=createNativeProfileScope(process.cwd());
  const combat=createBattlefieldCombat(()=>{});
  const profile=Object.assign(s.I3(),{fac:'wudu',lvl:150,main:'basic'});
  const stats=combat.statsFor(profile);
  const source={id:'mounted',kind:'player',team:'song',profile,stats,hp:stats.life,max:stats.life,mana:100,
    x:680,y:2784,cooldown:0,actionRevision:0,stun:0,r:15,mounted:true};
  const target={...source,id:'target',team:'jin',x:720,mounted:false};
  const skill={...stats.basic,id:1066,rad:150,cost:20};
  assert.equal(combat.cast(source,target,()=>[source,target],skill),false);
  assert.equal(source.mana,100);
  source.mounted=false;
  assert.equal(combat.cast(source,target,()=>[source,target],skill),true);
  assert.equal(source.mana,80);
});

test('Tống Kim uses the field ellipse, hitbox radius and self-area reach at the boundary',()=>{
  const {createBattlefieldCombat}=require('../src/server/battlefield-combat.ts');
  const combat=createBattlefieldCombat(()=>{});
  const source={x:680,y:2784};
  const skill={rad:100};
  assert.equal(combat.inRange(source,{x:776,y:2784,r:16},skill),true);
  assert.equal(combat.inRange(source,{x:778,y:2784,r:16},skill),false);
  assert.equal(combat.inRange(source,{x:680,y:2842,r:16},skill),true);
  assert.equal(combat.inRange(source,{x:680,y:2843,r:16},skill),false);
  assert.equal(combat.inRange(source,{x:760,y:2784,r:16},skill,true),false);
  assert.equal(combat.inRange(source,{x:780,y:2784,r:16},{rad:60,geo:{k:'self',r:120}}),true);
});

test('held movement advances every server tick and expires without a new direction packet',()=>{
  const {nativeScope:s}=createNativeProfileScope(process.cwd());
  const fight=createBattlefieldFight();
  const profile=Object.assign(s.I3(),{fac:'wudang',lvl:100,main:'basic',potOff:true});
  fight.join('hero','song',profile);
  const pos=()=>fight.snapshot().players[0].x;
  const initial=pos();
  fight.moveInput('hero',{x:1,y:0,sequence:1},true);
  assert.equal(pos(),initial);
  fight.tick(1/30);
  const first=pos();assert.ok(first>initial);
  fight.tick(1/30);
  assert.ok(pos()>first);
  for(let i=0;i<10;i++)fight.tick(1/30);
  const stopped=pos();
  fight.tick(1/30);
  assert.equal(pos(),stopped);
});

test('all ten SIM factions use the GM ten-slot equipment builder and can equip it',()=>{
  const {createBattlefieldCombat}=require('../src/server/battlefield-combat.ts');
  const combat=createBattlefieldCombat(()=>{});
  const factions=['shaolin','tianwang','tangmen','wudu','emei','cuiyan','gaibang','tianren','wudang','kunlun'];
  for(const faction of factions){
    const {profile,stats}=combat.computerProfile(faction,true);
    for(const slot of ['weapon','armor','helm','amulet','belt','cuff','boot','pendant','ring1','ring2']){
      const item=profile.eq[slot];
      assert.equal(item.lvl,10,faction+' '+slot);
      assert.equal(new Set(item.mag.map(entry=>entry.a)).size,5);
    }
    assert.ok(profile.eq.horse,faction);
    assert.equal(stats.main.id,profile.main,faction);
    assert.equal(profile.sk[profile.main],10,faction);
    assert.ok(stats.main.L>=10,faction+" effective skill includes equipment bonuses");
  }
  assert.equal(Object.keys(combat.computerProfile('shaolin').profile.eq).length,0);
});

test('Tống Kim Auto dismounts on the server before a grounded faction attack',()=>{
  const {createBattlefieldCombat}=require('../src/server/battlefield-combat.ts');
  const combat=createBattlefieldCombat(()=>{});
  const mounted=combat.computerProfile('wudang',true).profile;
  const other=combat.computerProfile('shaolin').profile;
  const fight=createBattlefieldFight();
  fight.join('horse','song',mounted);
  fight.join('target','jin',other);
  fight.move('target',710,2784);
  fight.setMounted('horse',true);
  fight.selectSkill('horse',null,false,true);
  fight.chooseTarget('horse','target');
  const own=()=>fight.snapshot().players.find(actor=>actor.id==='horse');
  assert.equal(own().mounted,true);
  for(let i=0;i<10;i++)fight.tick(1/30);
  assert.equal(own().mounted,true);
  assert.equal(own().casts,0);
  for(let i=0;i<30;i++)fight.tick(1/30);
  assert.equal(own().mounted,false);
  assert.ok(own().casts>0);
});
