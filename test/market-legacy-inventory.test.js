const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const { createServer }=require('../src/server/index.ts');
const { openDatabase }=require('../src/server/database.ts');
const { createMarket }=require('../src/server/market.ts');
const { accountCookie }=require('./helpers/accounts.js');

test('an approved existing character item is moved once and stale saves cannot restore it',async()=>{
  const db=openDatabase(':memory:');
  const { app }=createServer({db,downloadAssets:false});
  try {
    const seller=await accountCookie(app,'transfer_seller');
    const buyer=await accountCookie(app,'transfer_buyer');
    const request=(cookie,url,payload)=>app.inject({url,method:payload ? 'POST' : 'GET',headers:{cookie},
      ...(payload ? {payload:JSON.stringify(payload)} : {})});
    const marketOrders=(cookie,payload)=>request(cookie,'/api/market/transactions',payload);
    const read=async cookie=>(await request(cookie,'/api/storage')).json();
    const stock=async (cookie,slot='jxidle')=>(await request(cookie,'/api/market/inventory/'+slot)).json().items;
    const item={uid:42,n:'Nhẫn Thiên Thanh',d:3,lvl:10,mag:[{a:3,p:11}]};
    const carry={uid:4,n:'Huy Thủy Khôi',d:7,lvl:7};
    const sourceFile=fs.readFileSync('src/client/core/state-and-save-03.js','utf8');
    const codec=sourceFile.slice(sourceFile.indexOf('var Yd = function'),sourceFile.indexOf('var $ = function'));
    const {encode,decode}=vm.runInNewContext(sourceFile.match(/var mP = "[^"]*";/)[0]+codec+';({encode: bn, decode: t1})');
    const source=encode({uid:43,inv:[item,carry],gold:200});
    const assertSave=entry=>{const decoded=decode(entry);assert.equal(decoded.ok,true);assert.deepEqual(JSON.parse(JSON.stringify(decoded.state.inv)),[carry]);};
    const base=await read(seller);
    const write=(cookie,generation,id,entries)=>request(cookie,'/api/storage',{
      generation,id,operations:Object.entries(entries).map(([key,value])=>({key,value})),
    });
    const staleStash=JSON.stringify({items:[item,carry]});
    assert.equal((await write(seller,base.generation,'first',{jxidle:source,jxidle_bak:source,jxidle_stash_bak:staleStash})).statusCode,200);
    assert.equal((await write(buyer,(await read(buyer)).generation,'new-character',{jxidle:JSON.stringify({inv:[]})})).statusCode,200);
    assert.equal((await stock(seller)).length,2);
    const store=createMarket(db);
    const target=store.approveTransfer('transfer_seller','jxidle',item.uid);
    assert.equal(store.approveTransfer('transfer_seller','jxidle',item.uid),target);
    assert.equal((await stock(seller)).find(row=>row.id===target).legacy,true);
    assert.deepEqual((await stock(seller)).find(row=>row.id===target).item,item);
    store.issue('transfer-funds','transfer_buyer',{currency:'gold',amount:25});
    const sell={action:'sell',target,character:'jxidle',price:20,currency:'gold',requestId:'list-original'};
    assert.equal((await marketOrders(buyer,sell)).statusCode,409);

    db.exec(`CREATE TEMP TRIGGER fail_transfer BEFORE INSERT ON market_receipts
      WHEN NEW.request_id='list-original' BEGIN SELECT RAISE(ABORT,'forced transfer rollback'); END`);
    assert.equal((await marketOrders(seller,sell)).statusCode,500);
    assert.equal((await read(seller)).entries.jxidle,source);
    assert.equal((await stock(seller)).length,2);
    db.exec('DROP TRIGGER fail_transfer');

    const listed=await marketOrders(seller,sell);
    assert.equal(listed.statusCode,200,listed.body);
    assert.equal(listed.json().reloadCharacter,true);
    assert.deepEqual((await marketOrders(seller,sell)).json(),listed.json());
    for(const key of ['jxidle','jxidle_bak']) assertSave((await read(seller)).entries[key]);
    assert.deepEqual(JSON.parse((await read(seller)).entries.jxidle_stash_bak).items,[carry]);
    assert.equal((await write(seller,base.generation,'old-device',{
      jxidle:source,jxidle_bak:source,jxidle_2:source,jxidle_stash:staleStash,
    })).statusCode,200);
    for(const key of ['jxidle','jxidle_bak','jxidle_2']) assertSave((await read(seller)).entries[key]);
    assert.deepEqual(JSON.parse((await read(seller)).entries.jxidle_stash).items,[carry]);
    assert.throws(()=>store.approveTransfer('transfer_seller','jxidle',item.uid));

    const cancelled=await marketOrders(seller,{action:'cancel',target:listed.json().listingId,requestId:'cancel-original'});
    assert.equal(cancelled.statusCode,200,cancelled.body);
    assert.deepEqual((await stock(seller)).find(row=>row.id===target).item,item);
    const relisted=await marketOrders(seller,{...sell,requestId:'relist-original'});
    assert.equal(relisted.statusCode,200,relisted.body);
    const listing=relisted.json().listingId;
    assert.equal((await marketOrders(buyer,{action:'buy',target:listing,requestId:'buy-original'})).statusCode,200);
    assert.equal((await marketOrders(buyer,{action:'receive',target:listing,character:'jxidle',requestId:'receive-original'})).statusCode,200);
    assert.deepEqual((await stock(buyer))[0].item,item);
    assert.ok((await stock(seller)).every(row=>row.id!==target));
  } finally {await app.close();db.close();}
});
