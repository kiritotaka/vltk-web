const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../src/server/index.ts');
const {openDatabase}=require('../src/server/database.ts');
const {accountCookie}=require('./helpers/accounts.js');

test('synced equipment is sellable automatically while other storage and sold UIDs are excluded',async()=>{
  const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  try {
    const owner=await accountCookie(app,'sync_owner');
    const other=await accountCookie(app,'sync_other');
    const request=(cookie,url,data)=>app.inject({url,method:data?'POST':'GET',headers:{cookie},
      ...(data?{payload:JSON.stringify(data)}:{})});
    const state=(await request(owner,'/api/storage')).json();
    const write=(id,entries)=>request(owner,'/api/storage',{id,generation:state.generation,
      operations:Object.entries(entries).map(([key,value])=>({key,value}))});
    const stock=async(cookie=owner)=>(await request(cookie,'/api/market/inventory/jxidle')).json().items;
    const good={uid:3,n:'Đao',d:0,lvl:2};
    const locked={uid:4,n:'Khôi',d:7,lock:true};
    const worn={uid:5,n:'Áo đang mặc',d:2};
    const invalid={uid:6,n:'Vật phẩm dùng ngay',d:4,ktc:{c:1}};
    const old=JSON.stringify({inv:[good,locked,invalid],eq:{armor:worn}});
    const backup=JSON.stringify({inv:[{uid:90,n:'Đồ chỉ trong backup',d:3}]});
    const stash=JSON.stringify({items:[{uid:91,n:'Đồ chỉ trong kho',d:3}]});
    assert.equal((await write('offline-sync',{jxidle:old,jxidle_bak:backup,jxidle_stash:stash})).statusCode,200);
    assert.equal((await write('offline-sync',{jxidle:old})).statusCode,200);
    assert.equal(db.prepare('SELECT count(*) AS count FROM market_inventory_transfers').get().count,2);
    let items=await stock();
    assert.deepEqual(items.map(item=>item.name),[good.n]);

    const updated=JSON.stringify({inv:[{...good,lvl:3},{...locked,lock:false}]});
    assert.equal((await write('next-sync',{jxidle:updated})).statusCode,200);
    const id=items[0].id;
    items=await stock();
    assert.equal(items.find(item=>item.id===id).item.lvl,3);
    assert.ok(items.some(item=>item.item.uid===locked.uid));
    const order={action:'sell',target:id,character:'jxidle',price:1,currency:'gold',requestId:'synced-item-order'};
    assert.equal((await request(other,'/api/market/transactions',order)).statusCode,409);
    const sale=await request(owner,'/api/market/transactions',order);
    assert.equal(sale.statusCode,200,sale.body);
    assert.equal((await write('stale-device',{jxidle:old})).statusCode,200);
    assert.ok((await stock()).every(item=>item.id!==id));
    const sellerSave=(await request(owner,'/api/storage')).json().entries.jxidle;
    assert.ok(JSON.parse(sellerSave).inv.every(item=>item.uid!==good.uid));
    assert.equal(db.prepare('SELECT consumed FROM market_inventory_transfers WHERE id=?').get(id).consumed,1);
  } finally {await app.close();db.close();}
});

test('a character can publish only five simultaneous listings',async()=>{
  const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  try {
    const cookie=await accountCookie(app,'limit_owner');
    const req=(url,data)=>app.inject({url,method:data?'POST':'GET',headers:{cookie},
      ...(data?{payload:JSON.stringify(data)}:{})});
    const generation=(await req('/api/storage')).json().generation;
    const equipment=Array.from({length:6},(_,index)=>({uid:index+1,n:'Nhẫn '+index,d:3}));
    const save=await req('/api/storage',{generation,id:'initial-limit-save',operations:[
      {key:'jxidle',value:JSON.stringify({inv:equipment})},
      {key:'jxidle_2',value:JSON.stringify({inv:[{uid:1,n:'Món ô hai',d:3}]})},
    ]});
    assert.equal(save.statusCode,200,save.body);
    const list=async slot=>(await req('/api/market/inventory/'+slot)).json().items;
    const stock=await list('jxidle');
    const makeOrder=(item,n,character='jxidle')=>({action:'sell',target:item.id,requestId:'limit-'+n,
      character,price:1,currency:'gold'});
    const submit=data=>req('/api/market/transactions',data);
    const firstFour=[];
    for(let i=0;i<4;i++){
      const result=await submit(makeOrder(stock[i],i));
      assert.equal(result.statusCode,200,result.body);
      firstFour.push(result.json().listingId);
    }
    const remaining=[makeOrder(stock[4],4),makeOrder(stock[5],5)];
    const results=await Promise.all(remaining.map(submit));
    assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
    assert.match(results.find(r=>r.statusCode===409).json().error,/tối đa 5/);
    assert.equal((await submit(makeOrder((await list('jxidle_2'))[0],6,'jxidle_2'))).statusCode,200);
    assert.equal((await submit({action:'cancel',target:firstFour[0],requestId:'limit-cancel'})).statusCode,200);
    const retry=remaining[results.findIndex(r=>r.statusCode===409)];
    assert.equal((await submit(retry)).statusCode,200);
    assert.equal((await req('/api/market/listings')).json().listings.length,6);
  } finally {await app.close();db.close();}
});
