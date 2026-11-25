const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
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
      configs.push(config);
    }
    assert.notEqual(configs[0].instanceId, configs[1].instanceId);
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
  assert.match(bootstrap, /current\.instanceId === initialInstanceId/);
  assert.match(bootstrap, /setInterval\(checkServerVersion, 15000\)/);
  assert.match(bootstrap, /window\.dispatchEvent\(new Event\('volam:save-before-reload'\)\)/);
  assert.match(bootstrap, /await flush\(\)/);
  assert.match(bootstrap, /if \(queue\.length\)/);
  assert.match(bootstrap, /location\.reload\(\)/);
  assert.match(game, /addEventListener\('volam:save-before-reload'/);
});
