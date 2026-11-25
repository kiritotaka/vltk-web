const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('reward notification follows existing claimable reward state on both buttons',()=>{
  const source=fs.readFileSync('src/client/systems/rewards-02.js','utf8');
  const start=source.indexOf('var tt = function () {'),end=source.indexOf('\nvar et =',start);
  assert.ok(start>=0 && end>start);
  let claimable=true;
  const nodes=new Map(['#giftBtn','#u20gift'].map(id=>[id,{classes:new Set(),classList:{toggle(name,on){
    const node=nodes.get(id);
    if(on)node.classes.add(name);else node.classes.delete(name);
  }}}]));
  const scope={kh:()=>claimable,m:selector=>nodes.get(selector)||null};
  vm.runInNewContext(source.slice(start,end)+'\nthis.renderGiftBadge=tt;',scope);
  scope.renderGiftBadge();
  assert.equal(nodes.get('#giftBtn').classes.has('on'),true);
  assert.equal(nodes.get('#u20gift').classes.has('on'),true);
  claimable=false;
  scope.renderGiftBadge();
  assert.equal(nodes.get('#giftBtn').classes.has('on'),false);
  assert.equal(nodes.get('#u20gift').classes.has('on'),false);
});

test('round reward indicator does not affect Shop or Market buttons',()=>{
  const css=fs.readFileSync('public/ui20.css','utf8');
  const shell=fs.readFileSync('src/client/ui/world-shell-01.js','utf8');
  assert.match(css,/#u20gift\.on::after/);
  assert.doesNotMatch(css,/#u20(?:mkt|ktc)\.on::after/);
  assert.match(shell,/giftButton\.classList\.toggle\("on", typeof kh === "function" && kh\(\)\)/);
});
