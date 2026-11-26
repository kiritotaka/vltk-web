// Shared Tống Kim uses the existing world and input, with server-owned combat.
var sharedBattlefield = (() => {
  let session = null;
  let pending = false;
  let controls = null;
  const entities = new Map();
  const fields = ["clock",'bgImg','zoneShown','town','battlefield','life','mana','deadT','enemies','ground','fx','fxQ','corpses',
    'combatProjectiles','moveTo','manTgt','tgt','clickedTarget','pickTarget'];

  async function request(action, payload) {
    const response = await fetch('/api/battlefield/shared/' + action, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload),
      cache:'no-store', signal:AbortSignal.timeout(action==='join'?20000:5000),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Không kết nối được Tống Kim.'), { status:response.status });
    return data;
  }

  function ranking() {
    if (!session) return;
    const {combat,teams,finished} = session.state;
    const result=combat.score.song===combat.score.jin?'Hai phe hòa':combat.score.song>combat.score.jin?'Phe Tống thắng':'Phe Kim thắng';
    const list = combat.players.filter(actor=>actor.kind === 'player').sort((a,b)=>b.points-a.points || a.name.localeCompare(b.name,'vi'));
    J('<h3>Bảng xếp hạng · Tống Kim</h3>' + (finished?'<p><strong>'+result+'</strong></p>':'') +
      '<p>Tống: '+ combat.score.song +' quân trạng · '+teams.song.humans+'/100 người chơi</p>' +
      '<p>Kim: '+ combat.score.jin +' quân trạng · '+teams.jin.humans+'/100 người chơi</p>' +
      '<table><thead><tr><th>Hạng</th><th>Nhân vật</th><th>Phe</th><th>Điểm</th></tr></thead><tbody>' +
      list.map((actor,index)=>'<tr><td>'+(index+1)+'</td><td>'+D(actor.name)+'</td><td>'+
        (actor.team==='song'?'Tống':'Kim')+'</td><td>'+actor.points+'</td></tr>').join('') + '</tbody></table>');
  }

  async function openSupplies(shop=false) {
    const current=session;
    if (!current || current.finished) return;
    try {
      const supplies=await request("supplies",current.ref);
      if(session!==current || !supplies)return;
      const rows=supplies.items.filter(item=>shop || item.count>0);
      J("<h3>"+(shop?"Quan Quân Nhu":"Vật phẩm Tống Kim")+"</h3>"+
        (shop?"<p>Quân trạng tích lũy · "+supplies.merit+"</p>":"")+
        (rows.length?"<div class=\"shoplist\">"+rows.map(item=>
          "<div class=\"row\"><img width=\"26\" height=\"26\" src=\"/"+D(item.icon)+"\" alt=\"\"><span><b>"+D(item.name)+
          "</b> · "+item.count+"<br><small>"+D(item.description || "")+"</small></span>"+
          (shop?"<button class=\"btn sm\" data-war-item=\""+D(item.kind)+"\" data-quantity=\"1\">Mua · "+item.price+
            "</button><button class=\"btn sm\" data-war-item=\""+D(item.kind)+"\" data-quantity=\"10\">×10</button>"
            :"<button class=\"btn sm\" data-war-item=\""+D(item.kind)+"\" data-quantity=\"1\">Dùng</button>")+"</div>").join("")+"</div>"
          :"<p>Chưa có vật phẩm Tống Kim.</p>")+"<p id=\"shared-supply-status\" role=\"status\"></p>",()=>{
        m("#mBody")?.querySelectorAll("[data-war-item]").forEach(button=>{
          button.onclick=()=>void useSupply(current,shop,button.dataset.warItem,Number(button.dataset.quantity));
        });
      });
    } catch(error) { k(error.message); }
  }
  async function useSupply(current,shop,kind,quantity) {
    if(session!==current || current.supplying)return;
    const command={action:shop?"buy":"use",kind,quantity};
    const signature=JSON.stringify(command);
    const status=m("#shared-supply-status");
    if(current.pendingSupply && current.pendingSupply.signature!==signature){
      if(status)status.textContent="Hãy thử lại thao tác trước để xác nhận kết quả.";
      return;
    }
    current.pendingSupply??={signature,requestId:crypto.randomUUID()};
    current.supplying=true;
    try {
      await request("supplies",{...current.ref,...command,requestId:current.pendingSupply.requestId});
      current.pendingSupply=null;
      if(session===current)await openSupplies(shop);
    } catch(error) {
      if(error.status>=400&&error.status<500)current.pendingSupply=null;
      if(status)status.textContent=error.message;
    } finally { current.supplying=false; }
  }
  function installControls() {
    controls = document.createElement('div');
    controls.style.cssText='position:fixed;bottom:clamp(90px,17vh,140px);right:12px;z-index:20;display:flex;gap:6px';
    const standings=document.createElement('button');
    standings.type='button';standings.className='btn sm';standings.textContent='Bảng xếp hạng';standings.onclick=ranking;
    const leave=document.createElement('button');
    leave.type='button';leave.className='btn sm';leave.textContent='Rời Tống Kim';leave.onclick=()=>void exit();
    const timer=document.createElement('span');
    timer.id='shared-war-timer';timer.className='btn sm';timer.setAttribute?.('aria-live','off');
    const supplies=document.createElement("button");
    supplies.type="button";supplies.className="btn sm";supplies.textContent="Tiếp tế";supplies.onclick=()=>void openSupplies();
    controls.append(standings,leave,timer,supplies);
    document.body.append(controls);
  }

  function apply(state) {
    if (!session) return;
    session.state = state;
    const timer=m('#shared-war-timer');
    if (timer && Number.isFinite(state.endsAt-state.serverTime)) {
      const seconds=Math.max(0,Math.ceil((state.endsAt-state.serverTime)/1000));
      const text=Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
      if (timer.textContent!==text) timer.textContent=text;
    }
    const me = state.combat.players.find(actor=>actor.id===session.ref.participantId);
    if (!me) return;
    if (session.deaths !== me.deaths) {
      session.deaths=me.deaths;
      Object.assign(v,{x:me.x,y:me.y,px:me.x,py:me.y});
      Y.target=null;
      l.clickedTarget=l.manTgt=null;
    }
    if (session.casts !== undefined && session.casts !== me.casts) { v.act="at";v.actT=0; }
    session.casts=me.casts;
    session.position=me;
    l.life=me.hp;l.mana=me.mana;
    const visible=new Set();
    let changedActors=false;
    for (const actor of state.combat.players) {
      if (actor.id===me.id || actor.dead || Math.abs(actor.x-me.x)>1250 || Math.abs(actor.y-me.y)>1000) continue;
      visible.add(actor.id);
      let entity=entities.get(actor.id);
      if (!entity) {
        const tid=r0[actor.tid] ? actor.tid : Object.keys(r0).find(key=>r0[key]?.anim);
        entity={ id:actor.id, n:actor.name, tid, x:actor.x, y:actor.y, hp:actor.hp, max:actor.max,
          series:0, cls:actor.kind==='marshal'?'boss':'normal', sz:1, face:1, act:'st', actT:0, r:16,
          battlefieldTeam:actor.team, battlefieldMonster:true, sharedActor:true };
        entities.set(actor.id,entity);
        changedActors=true;
      }
      if (entity.casts !== undefined && entity.casts !== actor.casts) { entity.act="at"; entity.actT=0; }
      entity.casts=actor.casts;
      Object.assign(entity,{hp:actor.hp,max:actor.max,remoteX:actor.x,remoteY:actor.y,dead:false,stun:actor.stun?1:0});
    }
    for (const [id,entity] of entities) {
      if (visible.has(id)) continue;
      entity.dead=true; entities.delete(id); changedActors=true;
    }
    if(changedActors) {
      session.crowd=undefined;
      l.enemies=[...entities.values()];
    }
    if (state.finished && !session.finished) {
      session.finished=true;
      ranking();
    }
  }

  function enter(state) {
    const previous = {map:Z0.key, hero:{...v}, world:Object.fromEntries(fields.map(key=>[key,l[key]])), ctrl:o.ctrl, autoMap:o.autoMap};
    session={ state, previous, position:null, deaths:-1, sequence:state.player.movementSequence || 0,
      nextSync:0, finished:false, sending:false, ref:{matchId:state.matchId,participantId:state.player.id} };
    l.ground=[];
    ma(9003);
    Object.assign(l,{bgImg:bA(MapsEngine.getMapBackground(9003)),zoneShown:9003,town:false,battlefield:true,deadT:0,
      enemies:[],ground:[],fx:[],fxQ:[],corpses:[],combatProjectiles:[],moveTo:null,manTgt:null,tgt:null,clickedTarget:null,pickTarget:null});
    o.ctrl='manual';o.autoMap=false;
    m('#townBar')?.classList.add('hidden');
    installControls();
    apply(state);
  }

  async function exit(remote=true) {
    const current=session;
    if (!current) return;
    session=null;
    entities.clear();
    controls?.remove();
    controls=null;
    ma(current.previous.map);
    Object.assign(l,current.previous.world);
    Object.assign(v,current.previous.hero);
    o.ctrl=current.previous.ctrl;o.autoMap=current.previous.autoMap;
    m('#townBar')?.classList.toggle('hidden',!l.town);
    Y.target=null;
    if (remote) await request('leave',current.ref).catch(()=>{});
    await window.localGameStorage?.syncMarket?.();
  }

  async function join(team) {
    if (pending || session) return;
    pending=true;
    try {
      $();
      await window.localGameStorage?.flush();
      if (window.localGameStorage?.pending) throw new Error('Hãy đợi lưu nhân vật xong rồi thử lại.');
      const state=await request('join',{team,slot:y8()});
      n0(true);
      enter(state);
    } catch(error) {
      const status=m('#shared-war-status');
      if(status) status.textContent=error.message;
      else k(error.message);
    } finally { pending=false; }
  }

  function open() {
    if (session) { ranking(); return; }
    const role=window.localGameAuth?.user?.role;
    J('<h3>Chiêu Mộ Sứ · Tống Kim</h3><p>Hoang Nguyên · 20 phút</p><div class="btnrow">'+
      '<button class="btn" id="shared-war-song" type="button">Vào phe Tống</button>'+
      '<button class="btn" id="shared-war-jin" type="button">Vào phe Kim</button>'+
      (role==='gm'||role==='admin'?'<button class="btn" id="shared-war-practice" type="button">Trận thử</button>':'')+
      '</div><p id="shared-war-status" role="status"></p>',()=>{
        m('#shared-war-song').onclick=()=>void join('song');
        m('#shared-war-jin').onclick=()=>void join('jin');
        const practice=m('#shared-war-practice');
        if(practice) practice.onclick=()=>{n0(true);arenaSimulator.openSettings();};
      });
  }

  function target() {
    const selected=l.clickedTarget || l.manTgt;
    if (selected?.sharedActor && !selected.dead && selected.battlefieldTeam!==session.state.player.team) return selected;
    if (o.ctrl==='manual') return null;
    let nearest=null,best=Infinity;
    for (const actor of entities.values()) {
      if (actor.battlefieldTeam===session.state.player.team) continue;
      const gap=(v.x-actor.x)**2+4*(v.y-actor.y)**2;
      if(gap<best) { best=gap;nearest=actor; }
    }
    return nearest;
  }

  function drawLoot(context) {
    if (!session) return;
    for(const trap of session.state.combat.traps||[]){
      if(trap.x<B0.x-20||trap.x>B0.x+worldViewWidth()+20||trap.y<B0.y-20||trap.y>B0.y+worldViewHeight()+20)continue;
      context.strokeStyle=trap.kind==="freezeTrap"?"#83dcff":trap.kind==="stunTrap"?"#ffd06e":"#96e7a1";
      context.beginPath();context.ellipse(trap.x,trap.y,11,6,0,0,Math.PI*2);context.stroke();
    }
    for (const item of session.state.combat.drops || []) {
      if (item.x<B0.x-24 || item.x>B0.x+worldViewWidth()+24 || item.y<B0.y-24 || item.y>B0.y+worldViewHeight()+24)continue;
      const image=bA(item.icon);
      if (image?.naturalWidth) context.drawImage(image,item.x-9,item.y-18,18,18);
      else { context.fillStyle=item.color;context.fillRect(item.x-4,item.y-8,8,8); }
    }
  }
  function lootTarget(current) {
    if(o.ctrl==="manual" || !WA().auto)return null;
    let best=220,match=null;
    const now=performance.now();
    for(const item of current.state.combat.drops||[]){
      const gap=Math.hypot(item.x-v.x,(item.y-v.y)*2);
      if(gap>80&&gap<best&&!(current.skipLoot?.id===item.id&&now<current.skipLoot.until)){
        best=gap;match=item;
      }
    }
    if(!match){current.lootProgress=null;return null;}
    const prior=current.lootProgress;
    if(prior?.id!==match.id||best<prior.best-8)current.lootProgress={id:match.id,best,at:now};
    else if(now-prior.at>=3000){current.skipLoot={id:match.id,until:now+12000};current.lootProgress=null;return null;}
    return match;
  }
  function tick(dt) {
    const current=session;
    if (!current?.position) return;
    l.clock=(l.clock||0)+dt;
    const mix=Math.min(1,dt*12);
    v.x+=(current.position.x-v.x)*mix;
    v.y+=(current.position.y-v.y)*mix;
    const scene = typeof B0!=="undefined" ? B0 : null;
    const viewWidth = scene ? worldViewWidth() : 0;
    const viewHeight = scene ? worldViewHeight() : 0;
    for (const actor of entities.values()) {
      if (scene && (actor.remoteX<scene.x-140 || actor.remoteX>scene.x+viewWidth+140 ||
          actor.remoteY<scene.y-140 || actor.remoteY>scene.y+viewHeight+140)) {
        actor.x=actor.remoteX;actor.y=actor.remoteY;actor.moving=false;
        continue;
      }
      const x=actor.remoteX-actor.x,y=actor.remoteY-actor.y;
      actor.moving=Math.abs(x)+Math.abs(y)>1;
      if(actor.moving) { actor.face=x<0?-1:1;actor.dir=kn(x,y); }
      actor.x+=x*mix;actor.y+=y*mix;
    }
    if(current.finished || current.sending || performance.now()<current.nextSync) return;
    let [x,y]=Qv();
    const loot=!x&&!y ? lootTarget(current) : null;
    const aim=loot ? null : target();
    const chase=loot || (aim && Math.hypot(aim.x-v.x,(aim.y-v.y)*2)>Math.max(75,l.P?.main?.rad||75) && aim);
    if (!x&&!y&&chase) {
      const dx=chase.x-v.x,dy=chase.y-v.y,length=Math.hypot(dx,dy)||1;
      x=dx/length;y=dy/length;
    }
    const scale=Math.max(1,Math.hypot(x,y));
    current.nextSync=performance.now()+(x||y||aim?180:350);
    current.sending=true;
    const skill=o.mainLock ? (o.main==='basic'?0:Number(o.main)||null) : null;
    void request('sync',{...current.ref,target:aim?.id||null,skill,
      movement:{x:x/scale,y:y/scale,sequence:++current.sequence}})
      .then(state=>{if(session===current) apply(state);})
      .catch(error=>{
        if(session!==current) return;
        if(error.status===409 || error.status===401) {void exit(false);k(error.message);return;}
        current.nextSync=performance.now()+1000;
      })
      .finally(()=>{current.sending=false;});
  }
  function crowdFrame(renderer,actors,dt,view,selected,labels) {
    const current=session;
    const previous=current?.crowd;
    const focus=[...selected].map(actor=>actor.id).join(",");
    if (previous && performance.now()-previous.time<80 && focus===previous.focus &&
        Math.abs(view.x-previous.x)<36 && Math.abs(view.y-previous.y)<36 &&
        view.width===previous.width && view.height===previous.height && actors.length===previous.count) {
      previous.elapsed+=dt;
      return previous.frame;
    }
    const frame=renderer.update(actors,dt+(previous?.elapsed||0),view,selected,labels);
    if(current)current.crowd={ ...view,count:actors.length,focus,time:performance.now(),elapsed:0,frame };
    return frame;
  }
  document.addEventListener('keydown',event=>{
    if(session && event.key==='Escape' && m('#modal')?.classList.contains('hidden')) { event.stopImmediatePropagation();ranking(); }
  },true);
  return {open,tick,crowdFrame,drawLoot,openSupplies,get active(){return !!session;},get team(){return session?.state.player.team;}};
})();
