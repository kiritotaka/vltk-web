const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { createServer } = require('../src/server/index.ts');
const { openDatabase } = require('../src/server/database.ts');

test('config startup token changes across restarts without requiring a manual version bump', async () => {
  const instances = [];
  try {
    for (let i = 0; i < 2; i++) {
      const db = openDatabase(':memory:');
      const { app } = createServer({ db, downloadAssets:false });
      instances.push({ db, app });
    }
    const configs = [];
    for (const { app } of instances) {
      const response = await app.inject('/api/config');
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.headers['cache-control'], /no-store/);
      const config = response.json();
      assert.match(config.instanceId, /^[a-f0-9-]{36}$/i);
      assert.match(config.version, /^(?:[a-f0-9]{7,40}|build-[a-f0-9]{12})$/);
      configs.push(config);
    }
    assert.notEqual(configs[0].instanceId, configs[1].instanceId);
    assert.equal(configs[0].version, configs[1].version);
    assert.equal((await instances[0].app.inject('/api/config')).json().instanceId, configs[0].instanceId,
      'Token remains stable until the server restarts');
  } finally {
    for (const { app, db } of instances) {
      await app.close();
      db.close();
    }
  }
});

test('client compares server instance, saves player and waits for SQLite sync before reload', () => {
  const bootstrap = readFileSync('src/client/bootstrap.js','utf8');
  const game = readFileSync('src/client/core/game-loop-01.js','utf8');
  assert.match(bootstrap, /current\.instanceId !== initialInstanceId/);
  assert.match(bootstrap, /current\.version !== initialVersion/);
  assert.match(bootstrap, /setInterval\(checkServerVersion, 15000\)/);
  assert.match(bootstrap, /window\.dispatchEvent\(new Event\('volam:save-before-reload'\)\)/);
  assert.match(bootstrap, /await flush\(\)/);
  assert.match(bootstrap, /if \(queue\.length\)/);
  assert.match(bootstrap, /location\.reload\(\)/);
  assert.match(game, /addEventListener\('volam:save-before-reload'/);
});

test('a production process serves its startup bundle even after another build changes files', async () => {
  const db = openDatabase(':memory:');
  const { app } = createServer({ db, development: false, downloadAssets: false });
  const generated = ['src/client/game.js', 'src/client/game.js.map'];
  const original = generated.map(file => readFileSync(file));
  try {
    const before = await Promise.all(['/app/game.js', '/app/game.js.map'].map(url => app.inject(url)));
    assert.ok(before.every(response => response.statusCode === 200));
    writeFileSync(generated[0], '/* another checkout version */');
    writeFileSync(generated[1], '{}');
    for (const [i, url] of ['/app/game.js', '/app/game.js.map'].entries()) {
      const result = await app.inject(url);
      assert.equal(result.body, before[i].body);
      const head = await app.inject({ method: 'HEAD', url });
      assert.equal(head.statusCode, 200);
      assert.equal(head.body, '');
      assert.equal(Number(head.headers['content-length']), Buffer.byteLength(before[i].body));
    }
  } finally {
    for (const [i, file] of generated.entries()) writeFileSync(file, original[i]);
    await app.close();
    db.close();
  }
});
