const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHeadlessGame}=require('../tools/sim-balance/legacy-runtime.ts');

test('player returns immediately to either camp without a countdown, even after five deaths',()=>{
  const game=createHeadlessGame(process.cwd()),match=game.arenaSimulator.battlefield;
  for (const team of ['song','jin']) {
    match.start(team);
    for (let death=1;death<=6;death++) {
      game.l.life=0;game.l.mana=0;game.v.x+=100;
      match.playerDied();match.playerDied();
      assert.equal(game.v.x,match.state.camps[team].x);assert.equal(game.v.y,match.state.camps[team].y);
      assert.equal(game.l.life,game.l.P.life);assert.equal(game.l.mana,game.l.P.mana);
      assert.equal(game.l.deadT,0);assert.equal(match.state.playerDeaths,death);
    }
    match.reset();
  }
  assert.equal(game.simNodes.some(node=>node.id==='battlefield-respawn-countdown'),false);
});
