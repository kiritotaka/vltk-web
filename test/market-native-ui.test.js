const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('original market adapter runs inside the game bundle and uses the existing modal',async()=>{
  const manifest=require('../src/client/modules.json');
  assert.ok(manifest.modules.some(module=>module.file==='online/local-market-01.js'));
  const source=fs.readFileSync(path.join(__dirname,'../src/client/online/local-market-01.js'),'utf8');
  const pages=[];
  const scope={
    URLSearchParams,Number,String,
    D:value=>String(value),
    m:()=>null,
    J:(content,callback)=>{ pages.push(content);callback?.(); },
    Y0:(tab)=>'original '+tab,
    fetch:async()=>({ok:true,json:async()=>[]}),
  };
  vm.runInNewContext(source,scope);
  assert.equal(typeof scope.localMarket.open,'function');
  assert.equal(scope.Y0('acc'),'original acc','account tab should be untouched');
  scope.Y0('mkt');
  assert.match(pages[0],/id="mktTabs"/);
  assert.match(pages[0],/Bày bán/);
  assert.match(pages[0],/Hàng của tôi/);
  assert.match(pages[0],/mktListings/);
  assert.doesNotMatch(source,/market\.html/);
});

test('market integration is read-only while server-authoritative settlement is absent',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/client/online/local-market-01.js'),'utf8');
  assert.match(source,/rest\/v1\/market_listings/);
  assert.match(source,/status: 'eq\.active'/);
  assert.doesNotMatch(source,/method\s*:\s*['"](?:POST|DELETE|PATCH)['"]/);
  const game=fs.readFileSync(path.join(__dirname,'../src/client/ui/world-shell-01.js'),'utf8');
  assert.match(game,/localMarket\.open\(\)/);
});
