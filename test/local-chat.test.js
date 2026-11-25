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
    assert.equal((await app.inject('/client/local-chat.js')).statusCode,200);
  } finally {await app.close();db.close();}
});
