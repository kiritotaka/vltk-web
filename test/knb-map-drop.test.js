const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

test('map KNB drop rates are exact and one eligible kill is rolled once',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/client/core/state-and-save-02.js'),'utf8');
  const start=source.indexOf('var Cd = function');
  const end=source.indexOf('var d8 = function',start);
  const loot=fs.readFileSync(path.join(__dirname,'../src/client/gameplay/equipment-02.js'),'utf8');
  const luckSource=loot.match(/^var lootLuckMultiplier = [^\n]+;/m)[0];
  const noop=()=>{};
  let mapLevel=80, roll=0, rolls=0, awarded=0, saved=0, openWorld=true;
  const context={
    l:{enemies:[],battlefield:false,quiet:true}, o:{stage:1,lvl:200,gold:0}, d0:1,
    AA:()=>({lo:mapLevel}), Ga:()=>openWorld,
    Math:{...Math, min:Math.min, max:Math.max, round:Math.round, floor:Math.floor, random:()=>{rolls++; return roll;}},
    Dr:(reason,count)=>{assert.equal(reason,'monster'); awarded+=count;},
    $:()=>saved++, C:noop, lD:noop, YD:noop, _d:()=>0, Nd:()=>0, z5:()=>0,
    d8:()=>0, us:{normal:{xp:1},elite:{xp:1},boss:{xp:1}}, h8:()=>({rew:1}), Z7:()=>0,
    MP:noop, w0:[], P6:()=>[], R9:()=>[], jp:()=>null, ub:noop, Ib:noop, Fb:noop,
    Cy:noop, p7:noop, W3:noop, r0:[{anim:'mob'}], D:String,
  };
  vm.runInNewContext(luckSource+source.slice(start,end),context);
  for (const level of [1,10,20,30,40,50,60,70,79,200,NaN]) {
    assert.equal(context.worldKnbDropChance(level),0);
    assert.equal(context.worldKnbDropChance(level,true),0);
  }
  const rates=[0.001,0.0015,0.002,0.0025,0.003,0.0035,0.004,0.0045,0.005,0.0055,0.006,0.0065];
  for (const [i,rate] of rates.entries()) {
    const low=80+i*10;
    assert.equal(context.worldKnbDropChance(low),rate);
    assert.equal(context.worldKnbDropChance(low+9),rate);
    assert.equal(context.worldKnbDropChance(low,true),(20+5*i)/10000);
  }

  const kill=(kind='normal')=>{
    context.l.enemies=[{tid:0,hp:0,L:1,cls:kind,dead:false}];
    context.Cd();
    context.Cd();
  };
  mapLevel=79;
  kill('elite');
  assert.equal(rolls,0);
  mapLevel=80;
  roll=0.001;
  kill();
  assert.equal(rolls,1);
  assert.equal(awarded,0);
  roll=0.002;
  kill('elite');
  assert.equal(rolls,2);
  assert.equal(awarded,0);
  roll=0.001999;
  kill('elite');
  assert.equal(rolls,3);
  assert.equal(awarded,1);
  assert.equal(saved,1);
  context.l.P={lucky:20};
  assert.equal(context.lootLuckMultiplier(20),1.1);
  assert.equal(context.lootLuckMultiplier(1000),1.5);
  assert.equal(context.lootLuckMultiplier(-5),1);
  roll=0.00105;
  kill();
  assert.equal(awarded,2);
  roll=0.0021;
  kill('elite');
  assert.equal(awarded,3);
  mapLevel=79;
  kill('elite');
  mapLevel=80;
  kill('boss');
  openWorld=false;
  kill();
  assert.equal(rolls,5);
  assert.equal(awarded,3);
});
