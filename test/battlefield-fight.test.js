const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createBattlefieldFight}=require('../src/server/battlefield-fight.ts');
const {createNativeProfileScope}=require('../tools/sim-balance/native-profile-scope.ts');

test('native shared hit credits the opposing team and respawns the defeated player once',()=>{
  const {nativeScope, nativeGlobals}=createNativeProfileScope(process.cwd());
  const fight=createBattlefieldFight();
  const player = name => Object.assign(nativeScope.I3(), {fac:'wudang',name,lvl:100,main:'basic',lowFx:true});
  const attacker=player('Tống');
  attacker.attr.str=5000;
  const life=nativeGlobals.S.attr.indexOf('lifemax_v');
  attacker.eq={amulet:{d:4,lvl:1,base:[[life,250,250]],req:[],mag:[],s:-1}};
  fight.join('song','song',attacker);
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
      const profile=Object.assign(nativeScope.I3(),{fac:'wudang',name,lvl:100,main:'basic',lowFx:true});
      profile.attr.str=str;
      const account=db.prepare("SELECT id,generation FROM accounts WHERE username=?").get(name==='Tống'?'shared_tong':'shared_kim');
      const epoch=db.prepare("SELECT value FROM metadata WHERE key='generation'").get().value;
      const saved=await app.inject({method:'POST',url:'/test/save',headers:{cookie},payload:JSON.stringify({
        generation:epoch+':'+account.generation,id:'shared-profile',operations:[{key:'jxidle',value:JSON.stringify(profile)}],
      })});
      assert.equal(saved.statusCode,200,saved.body);
    }
    const a=await post(blue,'join',{team:'song',slot:'jxidle'}), b=await post(red,'join',{team:'jin',slot:'jxidle'});
    assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);
    const aRoom=a.json(), bRoom=b.json();
    assert.equal(aRoom.matchId,bRoom.matchId);
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
  const profile=Object.assign(nativeScope.I3(),{fac:'wudang',name:'Test',lvl:100,main:'basic'});
  fight.join('signed-in','song',profile);
  assert.equal(count('song','sim'),99);assert.equal(count('song','player'),1);
  assert.equal(count('song','npc'),35);assert.equal(count('jin','npc'),35);
  fight.leave('signed-in');
  fight.army({song:slots,jin:slots});
  assert.equal(count('song','sim'),100);assert.equal(count('song','npc'),35);
});

test('normal Fastify server runs the shared room with live troop slots',async()=>{
  const {createServer}=require('../src/server/index.ts');
  const {openDatabase}=require('../src/server/database.ts');
  const {accountCookie}=require('./helpers/accounts.js');
  const {nativeScope}=createNativeProfileScope(process.cwd());
  const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  const send=(cookie,url,data)=>app.inject({url,headers:{cookie},...(data?{method:'POST',payload:JSON.stringify(data)}:{})});
  try {
    const cookies=[await accountCookie(app,'live_tong'),await accountCookie(app,'live_kim')];
    const rooms=[];
    for(const [index,cookie] of cookies.entries()) {
      const saved=await send(cookie,'/api/storage');
      const value=JSON.stringify(Object.assign(nativeScope.I3(),{name:'Live '+index,fac:'wudang',lvl:100,main:'basic'}));
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
    assert.ok(rooms[1].combat.players.some(actor=>actor.kind==='sim'));
    const joined=rooms[1];
    const left=await send(cookies[1],'/api/battlefield/shared/leave',{matchId:joined.matchId,participantId:joined.player.id});
    assert.equal(left.json().teams.jin.sims,100);
    assert.equal(left.json().combat.players.filter(actor=>actor.kind==='player').length,1);
  } finally {await app.close();db.close();}
});

test('shared NPC loot belongs to its team and one drop can only be collected once',()=>{
  const {nativeScope}=createNativeProfileScope(process.cwd());
  const delivered=[];
  const fight=createBattlefieldFight(undefined,(id,kind)=>delivered.push([id,kind]),()=>0);
  const profile=Object.assign(nativeScope.I3(),{fac:'wudang',name:'Loot test',lvl:100,main:'basic'});
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

test('shared quartermaster prices, supplies and traps use a single durable receipt',async()=>{
 const {createServer}=require('../src/server/index.ts');
 const {openDatabase}=require('../src/server/database.ts');
 const {accountCookie}=require('./helpers/accounts.js');
 const {nativeScope}=createNativeProfileScope(process.cwd());
 const db=openDatabase(':memory:');const {app}=createServer({db,downloadAssets:false});
 try {
  const cookie=await accountCookie(app,'supply_tong');
  const other=await accountCookie(app,'supply_kim');
  const send=(url,data,session=cookie)=>app.inject({url,headers:{cookie:session},...(data?{method:'POST',payload:JSON.stringify(data)}:{})});
  const start=(await send('/api/storage')).json();
  const profile=Object.assign(nativeScope.I3(),{name:'Supply test',fac:'wudang',lvl:100,main:'basic'});
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
 const profile=name=>Object.assign(nativeScope.I3(),{name,fac:'wudang',lvl:100,main:'basic'});
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
