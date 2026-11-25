const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('../src/server/index.ts');
const {openDatabase}=require('../src/server/database.ts');
const {accountCookie}=require('./helpers/accounts.js');

for(const unit of ['gold','knb']) {
  test('inventory trade uses character '+unit+', delivers equipment and settles both saves once',async()=>{
    const db=openDatabase(':memory:');
    const {app}=createServer({db,downloadAssets:false});
    try {
      const seller=await accountCookie(app,'payment_seller');
      const buyer=await accountCookie(app,'payment_buyer');
      const req=(cookie,url,data)=>app.inject({url,method:data?'POST':'GET',headers:{cookie},
        ...(data?{payload:JSON.stringify(data)}:{})});
      const load=async cookie=>(await req(cookie,'/api/storage')).json();
      const state=async cookie=>JSON.parse((await load(cookie)).entries.jxidle);
      const save=(cookie,generation,id,value)=>req(cookie,'/api/storage',{generation,id,operations:[
        {key:'jxidle',value:JSON.stringify(value)},
      ]});
      const order=(cookie,data)=>req(cookie,'/api/market/transactions',data);
      const sellerGeneration=(await load(seller)).generation;
      const buyerGeneration=(await load(buyer)).generation;
      const ring={uid:8,n:'Càn Khôn Giới Chỉ',d:3,r:4,ic:'img/i/g44.png',mag:[{a:1,p:[2]}]};
      assert.equal((await save(seller,sellerGeneration,'seller-save',{uid:9,inv:[ring],gold:2,knb:2})).statusCode,200);
      assert.equal((await save(buyer,buyerGeneration,'buyer-save',{uid:15,inv:[],gold:12,knb:12,[unit]:9})).statusCode,200);
      const [asset]=(await req(seller,'/api/market/inventory/jxidle')).json().items;
      const sale=await order(seller,{action:'sell',target:asset.id,character:'jxidle',currency:unit,price:10,requestId:'sell-equipped'});
      assert.equal(sale.statusCode,200,sale.body);
      const target=sale.json().listingId;
      const [listing]=(await req(buyer,'/api/market/listings')).json().listings;
      assert.equal(listing.item_icon,ring.ic);
      assert.equal(listing.inventory_trade,1);

      const buy={action:'buy',target,character:'jxidle',requestId:'inventory-purchase'};
      const insufficient=await order(buyer,buy);
      assert.equal(insufficient.statusCode,409);
      assert.match(insufficient.json().error,/Hành trang không đủ/);
      assert.equal((await state(buyer))[unit],9);
      assert.equal((await save(buyer,buyerGeneration,'funded-full',{uid:15,inv:Array(60).fill(null),gold:12,knb:12})).statusCode,200);
      const full=await order(buyer,buy);
      assert.equal(full.statusCode,409);
      assert.match(full.json().error,/Hành trang không đủ chỗ/);
      assert.equal((await state(buyer))[unit],12);
      assert.equal((await save(buyer,buyerGeneration,'funded-empty',{uid:15,inv:[],gold:12,knb:12})).statusCode,200);
      db.exec(`CREATE TEMP TRIGGER fail_cash_receipt BEFORE INSERT ON market_receipts
        WHEN NEW.request_id='inventory-purchase' BEGIN SELECT RAISE(ABORT,'cash rollback'); END`);
      assert.equal((await order(buyer,buy)).statusCode,500);
      assert.equal((await state(buyer))[unit],12);
      assert.deepEqual((await state(buyer)).inv,[]);
      assert.equal((await state(seller))[unit],2);
      assert.equal((await load(buyer)).generation,buyerGeneration);
      db.exec('DROP TRIGGER fail_cash_receipt');

      const result=await order(buyer,buy);
      assert.equal(result.statusCode,200,result.body);
      assert.equal(result.json().reloadCharacter,true);
      assert.deepEqual((await order(buyer,buy)).json(),result.json());
      const buyerState=await state(buyer), sellerState=await state(seller);
      assert.equal(buyerState[unit],2);
      assert.equal(sellerState[unit],12);
      assert.equal(buyerState[unit==='gold'?'knb':'gold'],12);
      assert.equal(sellerState[unit==='gold'?'knb':'gold'],2);
      assert.deepEqual(buyerState.inv,[{...ring,uid:15}]);
      assert.deepEqual(sellerState.inv,[]);
      assert.equal((await req(buyer,'/api/market/mine')).json().wallet[unit],0);
      assert.equal((await req(seller,'/api/market/mine')).json().wallet[unit],0);
      assert.equal((await order(buyer,{action:'receive',target,character:'jxidle',requestId:'receive-again'})).statusCode,409);
      assert.equal((await save(buyer,buyerGeneration,'stale-buyer',{uid:15,inv:[],gold:12,knb:12})).statusCode,409);
      assert.equal((await save(seller,sellerGeneration,'stale-seller',{uid:9,inv:[],gold:2,knb:2})).statusCode,409);
    } finally {await app.close();db.close();}
  });
}
