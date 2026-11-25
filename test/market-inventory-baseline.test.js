const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../src/server/index.ts');
const {openDatabase}=require('../src/server/database.ts');
const {createMarket}=require('../src/server/market.ts');
const {accountCookie}=require('./helpers/accounts.js');

test('one inventory baseline covers existing eligible gear without changing character saves',async()=>{
  const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  try {
    const cookie=await accountCookie(app,'baseline_owner');
    const req=(url,data)=>app.inject({url,method:data===undefined?'GET':'POST',headers:{cookie},
      ...(data===undefined?{}:{payload:JSON.stringify(data)})});
    const state=(await req('/api/storage')).json();
    const unlocked={uid:1,n:'Nhẫn',d:3};
    const locked={uid:2,n:'Áo',d:2,lock:true};
    const replaced={uid:3,n:'Trang bị đã đổi chỉ số',d:7,lvl:4};
    const main=JSON.stringify({inv:[unlocked,locked,replaced,{uid:4,n:'Rương',d:3,ktc:{}}]});
    const alternate=JSON.stringify({inv:[{uid:1,n:'Mũ',d:7}],gold:1000});
    const update=(id,rows)=>req('/api/storage',{id,generation:state.generation,
      operations:Object.entries(rows).map(([key,value])=>({key,value}))});
    const list=async slot=>(await req('/api/market/inventory/'+slot)).json().items;
    const market=createMarket(db);
    assert.throws(()=>market.baselineInventory('baseline_owner'),/chưa có nhân vật/);
    // Existing accounts can have persisted saves from before automatic sync.
    const owner = db.prepare('SELECT id FROM accounts WHERE username=?').get('baseline_owner').id;
    const seed = db.prepare('INSERT INTO account_storage VALUES (?,?,?)');
    seed.run(owner, 'jxidle', main);
    seed.run(owner, 'jxidle_2', alternate);
    assert.deepEqual(await list('jxidle'),[]);
    assert.deepEqual(market.baselineInventory('baseline_owner'),{alreadyRecorded:false,count:4});
    assert.deepEqual((await req('/api/storage')).json().entries,{jxidle:main,jxidle_2:alternate});
    assert.deepEqual((await list('jxidle')).map(item=>item.name).sort(),[unlocked.n,replaced.n].sort());
    assert.deepEqual((await list('jxidle_2')).map(item=>item.name),['Mũ']);
    assert.equal((await update('later',{jxidle:JSON.stringify({inv:[
      unlocked,{...locked,lock:false},{...replaced,lvl:5},{uid:10,n:'Mới từ trình duyệt',d:3},
    ]})})).statusCode,200);
    assert.deepEqual(market.baselineInventory('baseline_owner'),{alreadyRecorded:true,count:4});
    const items=await list('jxidle');
    assert.deepEqual(items.map(item=>item.name).sort(),[unlocked.n,locked.n,replaced.n,'Mới từ trình duyệt'].sort());
    const gear=items.find(item=>item.name===locked.n);
    const listing=await req('/api/market/transactions',{action:'sell',requestId:'baseline-sell',target:gear.id,character:'jxidle',price:5,currency:'gold'});
    assert.equal(listing.statusCode,200,listing.body);
    assert.ok(!(await list('jxidle')).some(item=>item.id===gear.id));
  } finally {await app.close();db.close();}
});
