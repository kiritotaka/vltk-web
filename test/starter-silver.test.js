import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Verify the actual shared-scope client migration without loading the browser game.
const source = readFileSync('src/client/core/state-and-save-03.js', 'utf8');
const start = source.indexOf('var grantStarterSilver = function (state) {');
const end = source.indexOf('\nvar v8 = function', start);
assert.ok(start >= 0 && end > start, 'starter silver migration must exist');
const grant = runInNewContext(source.slice(start, end) + '\ngrantStarterSilver;');

test('legacy created character receives 50000 silver exactly once', () => {
  const old = { fac: 'test-faction', gold: 1234 };
  assert.equal(grant(old), true);
  assert.equal(old.gold, 51234);
  assert.equal(old.starterSilverV1, 1);
  assert.equal(grant(old), false);
  assert.equal(old.gold, 51234);
});

test('new character with marker does not receive a second grant', () => {
  const fresh = { fac: 'test-faction', gold: 50000, starterSilverV1: 1 };
  assert.equal(grant(fresh), false);
  assert.equal(fresh.gold, 50000);
});

test('empty character slots are not granted currency', () => {
  const empty = { fac: null, gold: 50000 };
  assert.equal(grant(empty), false);
  assert.equal(empty.starterSilverV1, undefined);
});

test('legacy zero-gold and malformed-gold characters receive a single grant', () => {
  for (const initial of [0, NaN, -100]) {
    const old = { fac: 'test-faction', gold: initial };
    assert.equal(grant(old), true);
    assert.equal(old.gold, 50000);
    assert.equal(grant(old), false);
  }
});
