/* Windows supervisor: npm run serve:auto. Never run with development privileges. */
'use strict';
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const onWindows=process.platform==='win32';
const npmCmd=onWindows?'npm.cmd':'npm';
const npxCmd=onWindows?'npx.cmd':'npx';
const POLL_MS=30000;
const log=(message)=>console.log('[serve:auto] '+message);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function run(cmd,args,cwd=root,timeout=600000){
  const result=spawnSync(cmd,args,{cwd,encoding:'utf8',timeout,windowsHide:true,
    shell:onWindows && (cmd===npmCmd || cmd===npxCmd),maxBuffer:8*1024*1024});
  if(result.error || result.status!==0){
    throw new Error(cmd+' '+args.join(' ')+': '+String(result.stderr||result.stdout||result.error?.message||result.status).trim());
  }
  return (result.stdout||'').trim();
}
const git=(...args)=>run('git',args);
const npm=(args,cwd=root)=>run(npmCmd,args,cwd);
const clean=()=>git('status','--porcelain','--untracked-files=no')==='';
const head=()=>git('rev-parse','HEAD');
function canFastForward(from,to){
  return spawnSync('git',['merge-base','--is-ancestor',from,to],{cwd:root,windowsHide:true}).status===0;
}
let server=null, updating=false, quitting=false, serverStopping=null;
function startServer(){
  if(server||quitting)return;
  const child=spawn(process.execPath,['src/server/index.ts'],{cwd:root,
    env:{...process.env,NODE_ENV:'production'},stdio:['inherit','inherit','inherit','ipc']});
  server=child;
  log('Serving http://127.0.0.1:'+(process.env.PORT||3000)+' (pid '+child.pid+').');
  child.once('exit',(code,signal)=>{
    if(server===child)server=null;
    if(!quitting&&!updating){
      log('Server exited ('+(signal||code)+'); restarting.');
      setTimeout(()=>{if(!server&&!quitting&&!updating)startServer();},3000);
    }
  });
  child.on('error',e=>log('Server error: '+e.message));
}
async function stopServer(){
  if(serverStopping)return serverStopping;
  const child=server;if(!child)return;
  serverStopping=(async()=>{
    if(child.exitCode!==null||child.signalCode!==null){server=null;return;}
    const exited=new Promise(resolve=>child.once('exit',resolve));
    try{if(child.connected)child.send('volam:shutdown');else child.kill();}
    catch{try{child.kill();}catch{}}
    const stopped=await Promise.race([exited.then(()=>true),wait(12000).then(()=>false)]);
    if(!stopped){log('Graceful shutdown timeout; terminating process.');try{child.kill();}catch{}}
    if(server===child)server=null;
  })().finally(()=>{serverStopping=null;});
  return serverStopping;
}
async function verifyCandidate(commit){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'vltk-candidate-'));
  let attached=false;
  try{
    git('worktree','add','--detach',temp,commit);attached=true;
    log('Preflight '+commit.slice(0,9)+' in temporary Git worktree.');
    npm(['ci','--include=dev'],temp);
    if(fs.existsSync(path.join(temp,'tools','map-tool','pnpm-lock.yaml')))
      run(npxCmd,['--yes','pnpm@10.25.0','--dir','tools/map-tool','install','--frozen-lockfile','--ignore-scripts'],temp);
    npm(['run','build'],temp);
  }finally{
    if(attached){try{git('worktree','remove','--force',temp);}catch(e){log('Worktree cleanup: '+e.message);}}
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
async function check(){
  if(updating||quitting)return;updating=true;
  try{
    if(git('branch','--show-current')!=='main'||!clean()){
      log('Update skipped: expected a clean main branch.');return;
    }
    git('fetch','--no-tags','origin','main');
    const before=head(),target=git('rev-parse','FETCH_HEAD');
    if(before===target)return;
    if(!canFastForward(before,target)){log('Branch diverged; manual review required.');return;}
    await verifyCandidate(target); // Never stop working server for a broken candidate.
    if(quitting||!clean()||head()!==before){log('Checkout changed; update cancelled.');return;}
    log('Candidate passed; installing '+target.slice(0,9));
    await stopServer();
    try{
      git('merge','--ff-only',target);
      npm(['ci','--include=dev']);
      npm(['run','build']);
    }catch(error){
      log('Deploy error: '+error.message);
      if(head()===target&&clean()){
        try{
          git('reset','--hard',before);
          npm(['ci','--include=dev']);
          npm(['run','build']);
          log('Previous release restored.');
        }catch(restore){log('Rollback requires attention: '+restore.message);}
      }
      throw error;
    }finally{if(!quitting)startServer();}
    log('Deployed '+target.slice(0,9));
  }catch(error){log('Update skipped: '+error.message);if(!server&&!quitting)startServer();}
  finally{updating=false;}
}
async function main(){
  if(git('branch','--show-current')!=='main')throw Error('Switch to the main branch first.');
  if(!clean())throw Error('Commit or stash tracked local changes first. They will never be overwritten.');
  npm(['run','build']);startServer();
  const timer=setInterval(()=>{void check();},POLL_MS);
  async function stop(){
    if(quitting)return;quitting=true;clearInterval(timer);
    await stopServer();process.exit(0);
  }
  process.once('SIGINT',()=>{void stop();});
  process.once('SIGTERM',()=>{void stop();});
  log('Monitoring origin/main every 30 seconds. Leave Cloudflare Tunnel running separately.');
}
if(require.main===module)main().catch(error=>{console.error('[serve:auto] '+error.message);process.exitCode=1;});
module.exports={canFastForward,POLL_MS};
