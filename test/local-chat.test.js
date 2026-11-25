const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/server/database.ts');
const { createServer } = require('../src/server/index.ts');

const register = (app, username) => app.inject({method:'POST',url:'/api/auth/register',payload:{username,password:'password123'}});
const cookie = r => r.headers['set-cookie'].split(';')[0];

test('world chat enforces sessions, records messages and blocks impersonation', async () => {
  const db = openDatabase(':memory:');
  const { app } = createServer({db,downloadAssets:false});
  try {
    assert.equal((await app.inject('/api/chat/messages')).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/chat/messages',payload:{body:'hello'}})).statusCode,401);
    const alice = cookie(await register(app,'chat_alice'));
    const bob = cookie(await register(app,'chat_bob'));
    const post = (session,payload) => app.inject({method:'POST',url:'/api/chat/messages',headers:{cookie:session},payload});
    const first = await post(alice,{body:'  Xin  chào  ',username:'fake_name'});
    assert.equal(first.statusCode,201,first.body);
    assert.equal(first.json().message.username,'chat_alice');
    assert.equal(first.json().message.body,'Xin chào');
    const list = await app.inject({url:'/api/chat/messages',headers:{cookie:bob}});
    assert.equal(list.statusCode,200);
    assert.equal(list.json().messages.length,1);
    assert.equal(list.json().messages[0].username,'chat_alice');
    assert.equal((await post(alice,{body:'again'})).statusCode,429);
    assert.equal((await post(bob,{body:'  '})).statusCode,400);
    assert.equal((await post(bob,{body:'x'.repeat(181)})).statusCode,400);
    const send = await post(bob,{body:'Hello!'});
    assert.equal(send.statusCode,201,send.body);
    // Chat must run in the game's shared IIFE, not in an isolated script:
    // the legacy chat UI keeps H, yl and ex as closure-local variables.
    const manifest = require('../src/client/modules.json');
    assert.ok(manifest.modules.some(module => module.file === 'local-chat.js'));
    const bundle = require('../tools/build-app.js').assemble().code;
    assert.match(bundle, /Source: local-chat\.js/);
    assert.match(bundle, /Legacy forms already submit via yl\(\)/);
    assert.equal((await app.inject('/client/local-chat.js')).statusCode,404);
  } finally {await app.close();db.close();}
});

test('world chat sends a server-read equipment snapshot and rejects another account item', async () => {
  const db=openDatabase(':memory:');
  const {app}=createServer({db,downloadAssets:false});
  try {
    const owner=cookie(await register(app,'attach_owner'));
    const other=cookie(await register(app,'attach_other'));
    const call=(session,url,payload)=>app.inject({url,method:payload===undefined?'GET':'POST',
      headers:{cookie:session},...(payload===undefined?{}:{payload})});
    const state=(await call(owner,'/api/storage')).json();
    const item={uid:29,n:'Càn Khôn Giới Chỉ',d:3,lvl:10,r:4,mag:[{a:120,p:[2]}],private:'never exported'};
    const saved=await call(owner,'/api/storage',{generation:state.generation,id:'chat-equipment',
      operations:[{key:'jxidle',value:JSON.stringify({inv:[],eq:{ring1:item}})}]});
    assert.equal(saved.statusCode,200);
    const payload={body:'',attachment:{character:'jxidle',uid:29,name:'forged'}};
    assert.equal((await call(other,'/api/chat/messages',payload)).statusCode,409);
    const post=await call(owner,'/api/chat/messages',payload);
    assert.equal(post.statusCode,201,post.body);
    const {message}=post.json();
    assert.equal(message.body,'[Càn Khôn Giới Chỉ]');
    assert.equal(message.item.n,item.n);
    assert.deepEqual(message.item.mag,item.mag);
    assert.equal(message.item.uid,undefined);
    assert.equal(message.item.private,undefined);
    const incoming=(await call(other,'/api/chat/messages')).json().messages;
    assert.deepEqual(incoming,[message]);
  } finally {await app.close();db.close();}
});

test('local chat sends an attachment-only message and hands it to the native item renderer', async () => {
  const {readFileSync}=require('node:fs');
  const vm=require('node:vm');
  const body={uid:29,n:'Nhẫn',d:3};
  const sent=[];
  const scope={
    H:{}, ex:()=>{}, $g:()=>{}, yl:()=>{}, y8:()=> 'jxidle',
    BA:()=>{}, T2:()=>{}, setInterval:()=>{}, k:()=>{}, ai:()=>true,
    document:{hidden:false,body:{classList:{remove(){}}},getElementById:()=>null,addEventListener(){}},
    async fetch(_url,options) {
      if(options.method==='POST') sent.push(JSON.parse(options.body));
      return {ok:true,json:async()=>({messages:sent.length?[{id:1,username:'sender',body:'[Nhẫn]',createdAt:2,item:{n:'Nhẫn',d:3}}]:[]})};
    },
  };
  scope.window=scope;
  scope.lr=value=>{ scope.H.att=value; };
  vm.runInNewContext(readFileSync('src/client/local-chat.js','utf8'),scope);
  await new Promise(resolve=>setImmediate(resolve));
  scope.H.att=body;
  await scope.yl('');
  assert.deepEqual(sent,[{body:'',attachment:{character:'jxidle',uid:29}}]);
  assert.equal(scope.H.att,null);
  assert.equal(scope.H.msgs[0].sys,false);
  assert.equal(scope.H.msgs[0].item.n,'Nhẫn');
  assert.equal(scope.ai(scope.H.msgs[0]),false);
  assert.equal(scope.ai({id:99}),true);
});
