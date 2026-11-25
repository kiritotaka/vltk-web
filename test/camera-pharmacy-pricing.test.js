const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const pricingSource = readFileSync('src/client/core/state-and-save-02.js', 'utf8');
const start = pricingSource.indexOf('var Ot = (s) =>');
const end = pricingSource.indexOf(';', start);
assert.ok(start >= 0 && end > start, 'Canonical pharmacy price function must exist');
const pricingFn = runInNewContext(pricingSource.slice(start, end + 1) + '\nOt;', {
  ED: {
    life: [0, 50, 100, 500, 1000, 3000],
    mana: [0, 50, 100, 500, 1000, 3000],
    both: [0, 80, 150, 750, 1500, 4500],
  },
});

test('all pharmacy medicine prices are exactly one tenth', () => {
  for (const kind of ['life', 'mana']) {
    assert.equal(pricingFn({ kind, tier: 1, price: 50 }), 5);
    assert.equal(pricingFn({ kind, tier: 3, price: 500 }), 50);
    assert.equal(pricingFn({ kind, tier: 5, price: 3000 }), 300);
  }
  assert.equal(pricingFn({ kind: 'both', tier: 2, price: 150 }), 15);
  assert.equal(pricingFn({ kind: 'both', tier: 4, price: 1500 }), 150);
});

test('minimum medicine price is one silver', () => {
  assert.equal(pricingFn({ kind: 'life', tier: 99, price: 5 }), 1);
});

test('world camera is rendered at 80 percent; HUD uses original pixel ratio', () => {
  const camera = readFileSync('src/client/render/projectiles-01.js', 'utf8');
  const render = readFileSync('src/client/render/arena-02.js', 'utf8');
  const input = readFileSync('src/client/ui/legacy-panels-and-audio-04.js', 'utf8');
  assert.match(camera, /var gameWorldZoom = 0\.8;/);
  assert.match(render, /setTransform\(H1 \* gameWorldZoom/);
  assert.match(render, /n\.setTransform\(H1, 0, 0, H1, 0, 0\)/);
  assert.match(input, /\$8\(\) \* gameWorldZoom/);
});
