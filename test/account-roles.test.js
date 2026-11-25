const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {openDatabase}=require('../src/server/database.ts');
const {createServer}=require('../src/server/index.ts');

test('existing accounts migrate to USER; only offline CLI grants ADMIN to existing kiritotaka', async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'volam-rbac-')), database=path.join(dir,'game.sqlite');
  let db;
  try {
    db=openDatabase(database);
    // Emulate the existing SQLite account table before roles were introduced.
    db.exec(`CREATE TABLE accounts(
      id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,generation TEXT NOT NULL,initialized INTEGER NOT NULL DEFAULT 1
    );`);
    const add=db.prepare('INSERT INTO accounts (id,username,salt,password_hash,generation,initialized) VALUES (?,?,?,?,?,?)');
    add.run('one','kiritotaka','salt','hash','gen',1);
    add.run('two','ordinary_user','salt','hash','gen',1);
    db.close();db=null;
    const {app,db:running}=createServer({db:openDatabase(database),downloadAssets:false});
    try {
      const roles=running.prepare('SELECT username,role FROM accounts ORDER BY username').all();
      assert.deepEqual(roles.map(x=>x.role),['user','user']);
    }finally{await app.close();running.close();}
    const invoke=(name,role)=>spawnSync(process.execPath,['tools/set-account-role.js',name,role],{
      cwd:path.join(__dirname,'..'),env:{...process.env,DB_PATH:database},encoding:'utf8'
    });
    const grant=invoke('kiritotaka','admin');
    assert.equal(grant.status,0,grant.stderr);
    db=openDatabase(database);
    assert.equal(db.prepare('SELECT role FROM accounts WHERE username=?').get('kiritotaka').role,'admin');
    assert.equal(db.prepare('SELECT role FROM accounts WHERE username=?').get('ordinary_user').role,'user');
    db.close();db=null;
    assert.notEqual(invoke('nonexistent','admin').status,0,'unknown accounts cannot be created/elevated by role tool');
  }finally{
    db?.close();rmSync(dir,{recursive:true,force:true});
  }
});
