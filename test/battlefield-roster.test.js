const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createBattlefieldRoster } = require('../src/server/battlefield-roster.ts');

test('one match fills each team to 100 and keeps 35 independent NPCs', () => {
  const roster = createBattlefieldRoster(() => 0);
  const first = roster.join('A', 'song');
  const second = roster.join('B', 'jin');
  assert.equal(first.matchId, second.matchId);
  assert.equal(second.teams.song.soldiers, 35);
  assert.equal(second.teams.jin.soldiers, 35);
  assert.equal(second.teams.song.sims, 99);
  assert.equal(second.teams.jin.sims, 99);
  assert.equal(second.teams.song.simSeats.includes(first.player.seat), false);
  assert.deepEqual(roster.join('A', 'song').player, first.player);
  assert.throws(() => roster.join('A', 'jin'), { status:409 });
  let result;
  for (let n = 1; n < 100; n++) result = roster.join('song-' + n, 'song');
  assert.equal(result.teams.song.humans, 100);
  assert.equal(result.teams.song.sims, 0);
  assert.equal(result.teams.jin.sims, 99);
  assert.throws(() => roster.join('overflow','song'), { status:409 });
  assert.throws(() => roster.leave('B',first.matchId,first.player.id), { status:409 });
  assert.equal(roster.leave('A',first.matchId,first.player.id).teams.song.sims,1);
  const replacement = roster.join('overflow','song');
  assert.equal(replacement.player.seat, first.player.seat);
  assert.notEqual(replacement.player.id, first.player.id);
  assert.throws(() => roster.leave('A',first.matchId,first.player.id), { status:409 });
});

test('an expired participant frees a seat and a match ID cannot control the next round', () => {
  let now = 0;
  const roster = createBattlefieldRoster(() => now);
  const first = roster.join('A','song');
  const second = roster.join('B','jin');
  now = 20_000;
  assert.equal(roster.sync('B',first.matchId,second.player.id).teams.song.humans,1);
  now = 30_000;
  assert.equal(roster.sync('B',first.matchId,second.player.id).teams.song.sims,100);
  assert.throws(() => roster.sync('A',first.matchId,first.player.id), { status:409 });
  now = 1_200_000;
  assert.equal(roster.sync('B',first.matchId,second.player.id).finished,true);
  assert.notEqual(roster.join('A','song').matchId,first.matchId);
  assert.throws(() => roster.leave('B',first.matchId,second.player.id), { status:409 });
});

test('Fastify roster authenticates two SQLite accounts, validates slots, and rejects cross-account leave', async () => {
  const { createServer } = require('../src/server/index.ts');
  const { openDatabase } = require('../src/server/database.ts');
  const { accountCookie } = require('./helpers/accounts.js');
  const db = openDatabase(':memory:');
  const { app } = createServer({ db, downloadAssets:false });
  const send = (action, body, cookie) => app.inject({
    method:'POST', url:'/api/battlefield/roster/'+action, payload:JSON.stringify(body),
    headers:cookie ? { cookie } : {},
  });
  try {
    const first = await accountCookie(app,'roster_one');
    const second = await accountCookie(app,'roster_two');
    assert.equal((await send('join',{ slot:'jxidle',team:'song' })).statusCode,401);
    assert.equal((await send('join',{ slot:'jxidle',team:'song' },first)).statusCode,409);
    for (const cookie of [first,second]) {
      const state = (await app.inject({ url:'/api/storage', headers:{cookie} })).json();
      const saved = await app.inject({ method:'POST', url:'/api/storage', headers:{cookie}, payload:JSON.stringify({
        generation:state.generation, id:'initial-character', operations:[
          { key:'jxidle', value:JSON.stringify({ name:'Test warrior', fac:'wudang' }) },
        ],
      }) });
      assert.equal(saved.statusCode,200);
    }
    const a = await send('join',{ slot:'jxidle', team:'song' },first);
    const b = await send('join',{ slot:'jxidle', team:'song' },second);
    assert.equal(a.statusCode,200);
    assert.equal(b.statusCode,200);
    const {matchId,player} = a.json();
    assert.equal(b.json().matchId,matchId);
    assert.equal(b.json().teams.song.sims,98);
    assert.equal(b.json().teams.jin.sims,100);
    const reference = { matchId, participantId:player.id };
    assert.equal((await send('leave',reference,second)).statusCode,409);
    assert.equal((await send('leave',reference,first)).json().teams.song.sims,99);
  } finally { await app.close(); db.close(); }
});
