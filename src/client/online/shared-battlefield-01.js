// Shared Tống Kim uses the existing world and input, with server-owned combat.
var sharedBattlefield = (() => {
  let session = null;
  let pending = false;
  let controls = null;
  const entities = new Map();
  const fields = ["clock",'bgImg','zoneShown','town','battlefield','life','mana','deadT','enemies','ground','fx','fxQ','corpses',
    'combatProjectiles','mounted','rideCd','jx','moveTo','manTgt','tgt','clickedTarget','pickTarget'];

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
    const troopCount = (side) => side.humans+' người chơi · '+(side.sims||0)+' SIM · '+(side.soldiers||0)+' NPC';
    J('<h3>Bảng xếp hạng · Tống Kim</h3>' + (finished?'<p><strong>'+result+'</strong></p>':'') +
      '<p>Tống: '+ combat.score.song +' quân trạng · '+troopCount(teams.song)+'</p>' +
      '<p>Kim: '+ combat.score.jin +' quân trạng · '+troopCount(teams.jin)+'</p>' +
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
  async function openPharmacy() {
    const current=session;
    if(!current || current.finished)return;
    try {
      const store=await request("pharmacy",current.ref);
      if(session!==current||!store)return;
      const rows=store.items;
      J("<h3>Dược Điếm · Tống Kim</h3><p>Túi thuốc "+store.total+"/"+store.capacity+" bình</p>"+
        "<div class=\"btnrow\"><button class=\"btn sm\" id=\"war-pharmacy-refill\">Bổ sung đủ thuốc</button>"+
        "<button class=\"btn sm\" id=\"war-pharmacy-life\">Dùng HP · "+store.life+"</button>"+
        "<button class=\"btn sm\" id=\"war-pharmacy-mana\">Dùng MP · "+store.mana+"</button></div>"+
        "<div class=\"row\">"+["life","mana"].map(resource=>"<label>"+(resource==="life"?"Thuốc HP":"Thuốc MP")+
          " <select id=\"war-pharmacy-"+resource+"-select\"><option value=\"auto\">Tự động</option>"+
          rows.filter(item=>item.kind===resource||item.kind==="both").map(item=>
            "<option value=\""+D(item.key)+"\""+(store.selected[resource]===item.key?" selected":"")+">"+D(item.n)+"</option>").join("")+
          "</select></label>").join("")+"</div><div class=\"shoplist\">"+rows.map(item=>
          "<div class=\"row\"><b>"+D(item.n)+"</b><span>"+item.count+" bình · "+item.price+" lượng</span>"+
          "<button class=\"btn sm\" data-war-potion=\""+D(item.key)+"\" data-quantity=\"1\">Mua</button>"+
          "<button class=\"btn sm\" data-war-potion=\""+D(item.key)+"\" data-quantity=\"10\">×10</button></div>").join("")+
        "</div><p id=\"war-pharmacy-status\" role=\"status\"></p>",()=>{
          m("#war-pharmacy-refill").onclick=()=>void pharmacyCommand({action:"refill"},true);
          for(const resource of ["life","mana"]){
            m("#war-pharmacy-"+resource).onclick=()=>void pharmacyCommand({action:"use",resource},true);
            m("#war-pharmacy-"+resource+"-select").onchange=event=>void pharmacyCommand({action:"select",resource,key:event.target.value},true);
          }
          m("#mBody")?.querySelectorAll("[data-war-potion]").forEach(button=>{
            button.onclick=()=>void pharmacyCommand({action:"buy",key:button.dataset.warPotion,quantity:Number(button.dataset.quantity)},true);
          });
        });
    } catch(error) { k(error.message); }
  }
  async function pharmacyCommand(command,show=false) {
    const current=session;
    if(!current||current.finished||current.pharmacyBusy)return;
    const signature=JSON.stringify(command);
    if(current.pendingPharmacy && current.pendingPharmacy.signature!==signature){
      k("Hãy thử lại thao tác Dược Điếm trước để xác nhận kết quả.");
      return;
    }
    if(command.action!=="select")current.pendingPharmacy??={signature,requestId:crypto.randomUUID()};
    current.pharmacyBusy=true;
    try {
      await request("pharmacy",{...current.ref,...command,requestId:current.pendingPharmacy?.requestId});
      current.pendingPharmacy=null;
      if(show && session===current)await openPharmacy();
    } catch(error){
      if(error.status>=400&&error.status<500)current.pendingPharmacy=null;
      const status=show&&m("#war-pharmacy-status");
      if(status)status.textContent=error.message;else k(error.message);
    } finally {current.pharmacyBusy=false;}
  }
  function usePotion(resource){void pharmacyCommand({action:"use",resource});}
  function potionSlot(resource){return session?.state.combat.potionSlots?.[resource]||{ic:"",n:0,name:"Túi thuốc Tống Kim"};}
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
    const previousSlots=session.state.combat.potionSlots;
    const interval=(state.serverTime-session.state.serverTime)/1000;
    const receivedAt=performance.now();
    session.state = state;
    const changed=(key)=>previousSlots?.[key]?.n!==state.combat.potionSlots?.[key]?.n || previousSlots?.[key]?.name!==state.combat.potionSlots?.[key]?.name;
    if((changed("life")||changed("mana"))&&typeof qA==="function")qA();
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
      Object.assign(l,{deadT:0,clickedTarget:null,manTgt:null,moveTo:null,pickTarget:null});
      session.route=session.lootProgress=session.predictedInput=null;
    }
    if (session.casts !== undefined && session.casts !== me.casts) { v.act="at";v.actT=0; }
    session.casts=me.casts;
    session.position=me;
    if(typeof me.mounted==="boolean" && !!l.mounted!==me.mounted &&
        (session.mountSent===undefined || session.mountSent===!!l.mounted)){
      l.mounted=me.mounted;
      if(typeof O3==="function")O3();
    }
    v.sharedSupport=me.support;
    l.life=me.hp;l.mana=me.mana;
    const visible=new Set();
    let changedActors=false;
    for (const actor of state.combat.players) {
      if (actor.id===me.id || actor.dead || Math.abs(actor.x-me.x)>1250 || Math.abs(actor.y-me.y)>1000) continue;
      visible.add(actor.id);
      let entity=entities.get(actor.id);
      if (!entity) {
        const avatar=actor.kind==="player" || actor.kind==="sim";
        const tid=avatar ? undefined : r0[actor.tid] ? actor.tid : r0[599] ? 599 : undefined;
        entity={ id:actor.id, n:actor.name, tid, x:actor.x, y:actor.y, hp:actor.hp, max:actor.max,
          series:0, cls:actor.kind==='marshal'?'boss':'normal', sz:1, face:1, act:'st', actT:0, r:16,
          battlefieldTeam:actor.team, battlefieldMonster:!avatar, sharedActor:true };
        if(avatar){
          const sex=actor.appearance?.sex||0;
          const faction=actor.faction;
          const look=typeof Jt==="function" ? Jt(faction,sex) : null;
          const fallback=sex ? "emei" : "wudang";
          entity.sharedAvatar=true;entity.look=look || (typeof Jt==="function" ? Jt(fallback,sex) : null);
          entity.localTeam=session.state.player.team;
          entity.profile={fac:look?faction:fallback,sex,eq:Object.fromEntries(
            Object.entries(actor.appearance?.eq||{}).map(([slot,item])=>[slot,{...item,base:[],req:[],mag:[]}])
          ),attr:{},sk:{}};
          entity.stats={...l.P,mana:Math.max(0,actor.mana)};entity.mana=actor.mana;
        }
        entities.set(actor.id,entity);
        changedActors=true;
      }
      if (entity.casts !== undefined && entity.casts !== actor.casts) { entity.act="at"; entity.actT=0; }
      entity.casts=actor.casts;
      const dx=actor.x-entity.remoteX,dy=actor.y-entity.remoteY;
      const jump=entity.deaths!==actor.deaths || (Number.isFinite(dx) && Math.hypot(dx,dy)>160);
      if(jump){entity.x=actor.x;entity.y=actor.y;}
      Object.assign(entity,{hp:actor.hp,max:actor.max,remoteX:actor.x,remoteY:actor.y,
        fromX:entity.x,fromY:entity.y,receivedAt,blendMs:Math.max(100,Math.min(300,interval*1000||125)),deaths:actor.deaths,
        dead:false,r:actor.r||16,stun:actor.stun?1:0,sharedSupport:actor.support,mounted:!!actor.mounted});
    }
    for (const [id,entity] of entities) {
      if (visible.has(id)) continue;
      entity.dead=true; entities.delete(id); changedActors=true;
    }
    if(changedActors) {
      session.crowd=undefined;
      l.enemies=[...entities.values()];
    }
    const latestVisual=session.visualId||0;
    const fresh=(state.combat.visuals||[]).filter(event=>event.id>latestVisual);
    const personal=event=>event.actor===me.id || event.target===me.id;
    const nearby=fresh.filter(event=>!personal(event)).slice(-24);
    for(const event of [...fresh.filter(personal),...nearby]){
      session.visualId=Math.max(session.visualId||0,event.id);
      const caster=event.actor===me.id?v:entities.get(event.actor);
      const from={x:event.x??caster?.x,y:event.y??caster?.y};
      const end={x:event.tx,y:event.ty,hp:1,r:16};
      if(!Number.isFinite(from.x)||!Number.isFinite(from.y)||l.fx.length>=(personal(event)?140:96))continue;
      if(caster){
        caster.face=end.x<from.x?-1:1;caster.dir=kn(end.x-from.x,end.y-from.y);
        caster.act="at";caster.actT=0;
      }
      if(event.actor===me.id && event.skill && event.skill!==1081 && typeof G8==="function")G8(event.skill);
      if(event.skill && typeof queueSkillContact==="function" && (!o.lowFx || event.actor===me.id || event.target===me.id)){
        const skill={id:event.skill,L:event.level,nMis:event.missiles,rad:event.rad,melee:event.melee,
          visualAnchor:{x:end.x,y:end.y-14},ox:from.x,oy:from.y,parts:{[event.element||"phys"]:1},
          geo:event.geo,ev:event.secondary,ev2:event.ev2,phys:event.phys,targets:event.targets,tot:1};
        if(typeof arenaSimulator!=="undefined" && arenaSimulator?.replayBattlefieldSkill) {
          const team=event.team || (event.actor===me.id ? state.player.team : caster?.battlefieldTeam);
          const range=Math.min(650,Math.max(180,event.rad||0,event.geo?.area||0));
          const targets=[end];
          if(team && (event.geo || event.secondary))for(const actor of state.combat.players) {
            if(actor.team===team || actor.id===event.target || actor.dead)continue;
            if(Math.min(Math.hypot(actor.x-end.x,actor.y-end.y),Math.hypot(actor.x-from.x,actor.y-from.y))<=range)
              targets.push({x:actor.x,y:actor.y,hp:1,r:16});
            if(targets.length>=24)break;
          }
          arenaSimulator.replayBattlefieldSkill({...from,hp:1,face:end.x<from.x?-1:1,dir:kn(end.x-from.x,end.y-from.y)},end,skill,targets);
        } else queueSkillContact(from,end,skill,()=>{}, {windup:0,targets:()=>[end]});
      } else {
        const color=event.actor===me.id||entities.get(event.actor)?.battlefieldTeam===session.state.player.team?"#ffd06e":"#c77bff";
        l.fx.push(event.melee ? {k:"ring",x:end.x,y:end.y,color,life:.24,max:.24,r:18} :
          {k:"line",x1:from.x,y1:from.y-16,x2:end.x,y2:end.y-14,color,life:.23,max:.23});
      }
    }
    for(const event of state.combat.supportVisuals || []){
      if(event.id<=(session.supportVisualId||0))continue;
      session.supportVisualId=event.id;
      if((!o.lowFx || event.actor===me.id) && l.fx.length<96)l.fx.push(CombatEngine.supportVisual(event.skill,event));
    }
    if (state.finished && !session.finished) {
      session.finished=true;
      ranking();
    }
  }

  function enter(state,slot) {
    const previous = {map:Z0.key, hero:{...v}, world:Object.fromEntries(fields.map(key=>[key,l[key]])), ctrl:o.ctrl, autoMap:o.autoMap};
    session={ state, slot, previous, position:null, deaths:-1, sequence:state.player.movementSequence || 0,
      nextSync:0, finished:false, sending:false, ref:{matchId:state.matchId,participantId:state.player.id} };
    l.ground=[];
    ma(9003);
    Object.assign(l,{bgImg:bA(MapsEngine.getMapBackground(9003)),zoneShown:9003,town:false,battlefield:true,deadT:0,
      enemies:[],ground:[],fx:[],fxQ:[],corpses:[],combatProjectiles:[],moveTo:null,manTgt:null,tgt:null,clickedTarget:null,pickTarget:null});
    o.autoMap=false;
    m('#townBar')?.classList.add('hidden');
    installControls();
    apply(state);
    if(typeof qA==="function")qA();
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
    delete v.sharedSupport;
    Object.assign(v,current.previous.hero);
    o.ctrl=current.previous.ctrl;o.autoMap=current.previous.autoMap;
    if(typeof qA==="function")qA();
    if(typeof O3==="function")O3();
    m('#townBar')?.classList.toggle('hidden',!l.town);
    Y.target=null;
    if (remote) await request('leave',current.ref).catch(()=>{});
    await window.localGameStorage?.syncMarket?.();
  }

  async function join(team, action='join') {
    if (pending || session) return;
    pending=true;
    try {
      $();
      await window.localGameStorage?.flush();
      if (window.localGameStorage?.pending) throw new Error('Hãy đợi lưu nhân vật xong rồi thử lại.');
      const slot=y8();
      const state=await request(action,{team,slot,...(action==='join'?{mounted:!!l.mounted}:{})});
      if(action==='register')return state;
      n0(true);
      enter(state,slot);
    } catch(error) {
      const status=m('#shared-war-status');
      if(status) status.textContent=error.message;
      else k(error.message);
    } finally { pending=false; }
  }

  function open() {
    if (session) { ranking(); return; }
    const role=window.localGameAuth?.user?.role;
    const format=timestamp=>new Date(timestamp).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Ho_Chi_Minh'});
    J('<h3>Chiêu Mộ Sứ · Tống Kim</h3><p>Hoang Nguyên · 30 phút</p><div class="btnrow">'+
      '<button class="btn" id="shared-war-song" type="button" disabled>Phe Tống</button>'+
      '<button class="btn" id="shared-war-jin" type="button" disabled>Phe Kim</button>'+
      (role==='gm'||role==='admin'?'<button class="btn" id="shared-war-manual" type="button" disabled>Mở trận chung</button>':'')+
      '</div><div class="btnrow" id="shared-war-next" hidden style="display:none">'+
      '<button class="btn" id="shared-war-next-song" type="button">Báo danh trận sau · Tống</button>'+
      '<button class="btn" id="shared-war-next-jin" type="button">Báo danh trận sau · Kim</button></div>'+
      '<p id="shared-war-status" role="status">Đang xem lịch Tống Kim…</p>',()=>{
        const status=m('#shared-war-status'),manual=m('#shared-war-manual');
        const buttons={song:m('#shared-war-song'),jin:m('#shared-war-jin')};
        let ready=false, registered=false;
        function show(state) {
          const entering=state.phase==='active';
          const registering=!entering && state.registrationOpen;
          const booking=state.registration;
          const late=entering && !state.manual && !booking;
          const candidate=booking?.slot===y8() ? booking.team : null;
          const teamName=booking?.team==='song'?'Tống':'Kim';
          status.textContent=entering ? (state.manual || candidate ? 'Trận đang diễn ra đến '+format(state.endsAt)+'.' :
            late ? 'Trận đang diễn ra đến '+format(state.endsAt)+'. Bạn có thể báo danh và vào ngay.' :
            'Hãy chọn đúng nhân vật đã báo danh phe '+teamName+'.') :
            registering ? (booking ? 'Đã báo danh phe '+teamName+'. Trận mở lúc ' : 'Đang báo danh. Trận mở lúc ')+format(state.nextStart)+'.' :
            'Báo danh lúc '+format(state.registrationAt)+'. Trận mở lúc '+format(state.nextStart)+'.';
          if(manual) manual.disabled=!state.canOpenManual;
          const next=m('#shared-war-next');
          if(next){
            next.hidden=!(entering && state.manual && state.registrationOpen);
            next.style.display=next.hidden?'none':'';
          }
          if(next && !next.hidden)for(const team of ['song','jin']){
            const button=m('#shared-war-next-'+team);
            button.disabled=!!booking;
            button.onclick=async()=>{
              const updated=await join(team,'register');
              if(updated){ready=true;show(updated);}
            };
          }
          for(const [team,button] of Object.entries(buttons)){
            const name=team==='song'?'Tống':'Kim';
            button.textContent=(registering?'Báo danh phe ':late?'Báo danh & vào phe ':entering?'Vào phe ':'Phe ')+name;
            button.disabled=registering ? !!booking : !entering || (late ? (state.teams?.[team]?.humans||0)>=100 : !state.manual && team!==candidate);
            button.onclick=async()=>{
              const updated=await join(team,registering?'register':'join');
              if(updated){ready=true;show(updated);}
            };
          }
          if(entering && !state.manual && ready && candidate && !registered){
            registered=true;
            void join(candidate);
          }
        }
        if(manual) manual.onclick=async()=>{
          manual.disabled=true;
          try { show(await request('manual',{})); }
          catch(error){ status.textContent=error.message; }
        };
        async function update(){
          if(session || m('#shared-war-status')!==status)return;
          try { const state=await request('status',{}); if(m('#shared-war-status')===status && !pending)show(state); }
          catch(error){status.textContent=error.message;}
          if(!session && m('#shared-war-status')===status) setTimeout(update,2000);
        }
        void update();
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
  function follow(current,destination) {
    if(typeof mt!=="function" || mt(v.x,v.y,destination.x,destination.y)){current.route=null;return destination;}
    if(typeof Bw!=="function")return destination;
    const now=performance.now(),old=current.route;
    if(!old||now>=old.retryAt||Math.hypot(old.x-destination.x,old.y-destination.y)>90){
      current.route={x:destination.x,y:destination.y,retryAt:now+750,points:Bw(v.x,v.y,destination.x,destination.y,2400)||[]};
    }
    const points=current.route.points;
    while(points.length&&Math.hypot(points[0].x-v.x,points[0].y-v.y)<16)points.shift();
    return points[0]||null;
  }
  function tick(dt) {
    const current=session;
    if (!current?.position) return;
    l.clock=(l.clock||0)+dt;
    const riding=!!l.mounted;
    if(current.renderedMount!==riding && typeof J3==="function" && typeof N8==="function"){
      current.renderedMount=riding;
      const previous=l.jx?.key;
      l.jx=J3() ? N8() : null;
      if(l.jx && l.jx.key!==previous && typeof Bf==="function")Bf();
    }
    if((l.rideCd||0)>0)l.rideCd=Math.max(0,l.rideCd-dt);
    if(typeof advanceSkillContacts==="function" && (l.fx.length || l.combatProjectiles.length || l.fxQ.length)) advanceSkillContacts(dt);
    const mix=1-Math.exp(-dt*16);
    const now=performance.now();
    const [inputX,inputY]=Qv();
    const manualMove = inputX || inputY;
    const prediction=manualMove ? {x:inputX,y:inputY} :
      (!current.wasMoving && o.ctrl!=="manual" && now-(current.lastSync||0)<220 ? current.predictedInput : null);
    if(prediction && (prediction.x || prediction.y) && !current.position.stun && v.act!=="at" &&
        typeof gt==="function"){
      const correctionX=current.position.x-v.x,correctionY=current.position.y-v.y;
      const ahead=-(correctionX*prediction.x+correctionY*prediction.y);
      const attenuation=Math.max(0,Math.min(1,(42-ahead)/24));
      const correction=Math.min(1,dt*(ahead>26?9:4));
      const speed=(typeof Ra==="function"?Ra():1)*(current.position.support?.speed || 1);
      const step=150*speed*dt*attenuation/Math.max(1,Math.hypot(prediction.x,prediction.y));
      gt(v,v.x+prediction.x*step+correctionX*correction,v.y+prediction.y*step+correctionY*correction);
    } else {
      v.x+=(current.position.x-v.x)*mix;
      v.y+=(current.position.y-v.y)*mix;
    }
    const scene = typeof B0!=="undefined" ? B0 : null;
    const viewWidth = scene ? worldViewWidth() : 0;
    const viewHeight = scene ? worldViewHeight() : 0;
    for (const actor of entities.values()) {
      if (scene && (actor.remoteX<scene.x-140 || actor.remoteX>scene.x+viewWidth+140 ||
          actor.remoteY<scene.y-140 || actor.remoteY>scene.y+viewHeight+140)) {
        actor.x=actor.remoteX;actor.y=actor.remoteY;actor.moving=false;
        continue;
      }
      const blend=Math.max(0,Math.min(1,(now-actor.receivedAt)/actor.blendMs));
      const x=actor.fromX+(actor.remoteX-actor.fromX)*blend;
      const y=actor.fromY+(actor.remoteY-actor.fromY)*blend;
      const dx=x-actor.x,dy=y-actor.y;
      actor.moving=blend<1 && Math.abs(actor.remoteX-actor.fromX)+Math.abs(actor.remoteY-actor.fromY)>1;
      if(actor.moving && actor.act!=="at" && (dx || dy)) { actor.face=dx<0?-1:1;actor.dir=kn(dx,dy); }
      actor.x=x;actor.y=y;
    }
    if(current.finished || current.sending || (now<current.nextSync && !(manualMove&&!current.wasMoving&&now-(current.lastSync||0)>75))) return;
    let [x,y]=[inputX,inputY];
    const loot=!x&&!y ? lootTarget(current) : null;
    const aim=loot ? null : target();
    const rallyPoint=current.state.combat.rally || {x:1792,y:1792};
    const rally=!aim && !loot && o.ctrl!=="manual" && Math.hypot(v.x-rallyPoint.x,v.y-rallyPoint.y)>18 ? rallyPoint : null;
    const attack=current.state.combat.attack || l.P?.main || {rad:75};
    const closeAttack=!!o.closeAtk && (typeof $1==="function" ? !$1() : o.ctrl!=="manual");
    const origin=current.position;
    const targetPosition=aim && {x:aim.remoteX,y:aim.remoteY,r:aim.r};
    const inRange=targetPosition && (typeof CombatEngine!=="undefined" && CombatEngine.withinSkillCastRange
      ? CombatEngine.withinSkillCastRange(origin,targetPosition,attack,closeAttack)
      : Math.hypot(targetPosition.x-origin.x,targetPosition.y-origin.y)<=(attack.rad||75));
    const ignoresTerrain=typeof skillIgnoresTerrain==="function" && skillIgnoresTerrain(attack);
    const obstructed=targetPosition && !ignoresTerrain && typeof mt==="function" &&
      !mt(origin.x,origin.y,targetPosition.x,targetPosition.y);
    const destination=loot || (targetPosition && (!inRange || obstructed) && targetPosition) || rally;
    const chase=!x&&!y&&destination && follow(current,destination);
    if (chase) {
      const dx=chase.x-v.x,dy=chase.y-v.y,length=Math.hypot(dx,dy)||1;
      x=dx/length;y=dy/length;
    }
    const scale=Math.max(1,Math.hypot(x,y));
    current.lastSync=now;current.wasMoving=!!manualMove;
    current.predictedInput={x:x/scale,y:y/scale};
    current.nextSync=now+(x||y||aim?125:300);
    current.sending=true;
    const skill=o.mainLock ? (o.main==='basic'?0:Number(o.main)||null) : null;
    current.mountSent=!!l.mounted;
    const mountChange=typeof current.position.mounted==="boolean" && current.mountSent!==current.position.mounted
      ? {mounted:current.mountSent} : {};
    const autoRide=typeof S3==="function" ? S3() : o.ctrl!=="manual" && o.autoRide!==false;
    void request('sync',{...current.ref,target:aim?.id||null,skill,...mountChange,manualMove:!!manualMove,shortRange:closeAttack,autoRide,
      movement:{...current.predictedInput,sequence:++current.sequence}})
      .then(state=>{if(session===current) apply(state);})
      .catch(error=>{
        if(session!==current) return;
        if(error.status===409)return resume(current);
        if(error.status===401) {void exit(false);k(error.message);return;}
        current.nextSync=performance.now()+1000;
      })
      .finally(()=>{current.sending=false;});
  }
  async function resume(current) {
    try {
      const state=await request('join',{matchId:current.ref.matchId,team:current.state.player.team,slot:current.slot});
      if(session!==current)return;
      if(state.matchId!==current.ref.matchId || !state.player) {
        void exit(false);k('Trận Tống Kim bạn tham gia đã kết thúc.');return;
      }
      if(current.ref.participantId!==state.player.id) {
        current.ref.participantId=state.player.id;
        current.deaths=-1;
        current.casts=undefined;
        current.sequence=state.player.movementSequence||0;
      }
      current.nextSync=0;
      apply(state);
    } catch(error) {
      if(session!==current)return;
      if(error.status===409 || error.status===401) {void exit(false);k(error.message);return;}
      current.nextSync=performance.now()+1000;
    }
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
  return {open,tick,crowdFrame,drawLoot,openSupplies,openPharmacy,usePotion,potionSlot,get active(){return !!session;},get team(){return session?.state.player.team;}};
})();
