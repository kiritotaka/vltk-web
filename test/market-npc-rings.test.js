const {test}=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase}=require('../src/server/database.ts');
const {createServer}=require('../src/server/index.ts');
const {accountCookie}=require('./helpers/accounts.js');

test('the NPC issues two real rings into Hành trang and records ownership atomically',async()=>{
  const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  try{
    const seller=await accountCookie(app,'npc_seller');
    const other=await accountCookie(app,'npc_other');
    const req=(cookie,url,method='GET',payload)=>app.inject({url,method,headers:cookie?{cookie}:{},
      ...(payload===undefined?{}:{payload:JSON.stringify(payload)})});
    const getSave=async cookie=>(await req(cookie,'/api/storage')).json();
    const save=(cookie,generation,id,value)=>req(cookie,'/api/storage','POST',
      {generation,id,operations:[{key:'jxidle',value}]});
    const claim='/api/market/trader-rings/jxidle';
    const previous=await getSave(seller);
    const full=JSON.stringify({uid:100, inv:Array(60).fill(null), gold:200});
    assert.equal((await req(null,claim,'POST')).statusCode,401);
    assert.equal((await save(seller,previous.generation,'full',full)).statusCode,200);
    assert.equal((await req(seller,claim,'POST')).statusCode,409);
    assert.equal((await getSave(seller)).entries.jxidle,full);

    const original=JSON.stringify({uid:100, inv:[{uid:9,d:3,n:'Old item'}], gold:200});
    assert.equal((await save(seller,previous.generation,'shorter',original)).statusCode,200);
    const attempts=await Promise.all([req(seller,claim,'POST',{item:'fake'}),req(seller,claim,'POST')]);
    assert.ok(attempts.every(result=>result.statusCode===200),attempts.map(result=>result.body).join('\n'));
    assert.equal(attempts.filter(result=>!result.json().alreadyClaimed).length,1);

    const current=await getSave(seller);
    const character=JSON.parse(current.entries.jxidle);
    assert.notEqual(current.generation,previous.generation);
    assert.equal(character.gold,200);
    assert.equal(character.uid,102);
    const equipment=character.inv.filter(item=>item.uid>=100);
    assert.equal(equipment.length,2);
    assert.ok(equipment.every(item=>item.n==='Càn Khôn Giới Chỉ'&&item.r===4&&item.mag.some(line=>line.p.includes(2))));
    assert.equal((await save(seller,previous.generation,'stale',original)).statusCode,409);
    const listed=(await req(seller,'/api/market/inventory/jxidle')).json().items.filter(row=>row.item.uid>=100);
    assert.equal(listed.length,2);
    assert.deepEqual(listed.map(row=>row.item.uid).sort(),[100,101]);
    const order={action:'sell',requestId:'sell-npc-ring',character:'jxidle',target:listed[0].id,price:1,currency:'gold'};
    assert.equal((await req(other,'/api/market/transactions','POST',order)).statusCode,409);
    assert.equal((await req(seller,'/api/market/transactions','POST',order)).statusCode,200);
    const after=JSON.parse((await getSave(seller)).entries.jxidle);
    assert.deepEqual(after.inv.map(item=>item.uid).sort(),[9,listed[1].item.uid].sort());
  } finally {await app.close();db.close();}
});
