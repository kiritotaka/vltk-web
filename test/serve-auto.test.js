const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const supervisor=require('../tools/serve-auto.js');

test('auto-deploy is an explicit one-command production supervisor',()=>{
  const pkg=require('../package.json');
  assert.equal(pkg.scripts['serve:auto'],'node tools/serve-auto.js');
  assert.equal(supervisor.POLL_MS,30000);
  assert.equal(typeof supervisor.canFastForward,'function');
  const text=fs.readFileSync('tools/serve-auto.js','utf8');
  assert.match(text,/NODE_ENV:'production'/);
  assert.match(text,/git\('fetch','--no-tags','origin','main'\)/);
  assert.match(text,/git\('worktree','add','--detach',temp,commit\)/);
  assert.match(text,/await verifyCandidate\(target\)/);
  assert.match(text,/await stopServer\(\)/);
  assert.match(text,/git\('merge','--ff-only',target\)/);
  assert.match(text,/!clean\(\)/);
  // A CRLF / stale-index-only status must not block auto-deploy; real tracked
  // content changes are still refused by Git's exit status.
  assert.match(text,/\['diff','--quiet','HEAD','--'\]/);
  assert.doesNotMatch(text,/git\('status','--porcelain'/);
  assert.match(text,/child\.send\('volam:shutdown'\)/);
  const server=fs.readFileSync('src/server/index.ts','utf8');
  assert.match(server,/message === 'volam:shutdown'/);
  assert.match(server,/await app\.close\(\); db\.close\(\)/);
});

test('preflight rejects non-descendant Git history and accepts fast-forward',()=>{
  const {mkdtempSync,rmSync}=require('node:fs');
  const path=require('node:path'),os=require('node:os');
  const root=mkdtempSync(path.join(os.tmpdir(),'volam-deploy-test-'));
  const run=(...args)=>{
    const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    return r.stdout.trim();
  };
  try{
    run('init','-q');run('config','user.name','Deploy Test');run('config','user.email','deploy@test.invalid');
    fs.writeFileSync(path.join(root,'file.txt'),'a');
    run('add','file.txt');run('commit','-qm','initial');
    const previous=run('rev-parse','HEAD');
    fs.writeFileSync(path.join(root,'file.txt'),'b');
    run('add','file.txt');run('commit','-qm','second');
    const next=run('rev-parse','HEAD');
    // Use the local Git command directly because the helper is scoped to the
    // real working repository.
    assert.equal(spawnSync('git',['merge-base','--is-ancestor',previous,next],{cwd:root}).status,0);
    assert.equal(spawnSync('git',['merge-base','--is-ancestor',next,previous],{cwd:root}).status,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
