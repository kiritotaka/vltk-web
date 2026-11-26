type Point = {x:number;y:number};
export type SupportEffect = (id:number, point:Point) => void;
type Actor = Point & {hp?:number;dead?:boolean;poison?:number;poisonDmg?:number;actionRevision?:number;castT?:number};
type Profile = {fac:string;lvl:number;sk?:Record<string,number>};
const schools = ['tianwang','shaolin','tangmen','wudu','emei','cuiyan','gaibang','tianren','wudang','kunlun'];
const anchors = [1,5,10,15,20];
const fearRadius = 150;
const table = (level:number, values:number[]) => {
  if (level<=1) return values[0];
  const end=anchors.findIndex(value=>value>=level);
  if(end<0)return values[4];
  const start=end-1;
  return values[start]+(values[end]-values[start])*(level-anchors[start])/(anchors[end]-anchors[start]);
};
const linear=(level:number,first:number,last:number)=>first+(last-first)*(level-1)/19;
export function supportLevel(profile:Profile, id:number) {
  if (!profile || !(profile.lvl>=120) || schools[id-708]!==profile.fac) return 0;
  return Math.max(0,Math.min(20,Math.floor(Number(profile.sk?.[id])||0)));
}
export function supportBonus(profile:Profile, skill:{f?:string;tier?:number}, kind:string) {
  const level=supportLevel(profile,712);
  return level && skill.f==='emei' && skill.tier!==120 && ['buff','aura','passive'].includes(kind)
    ? Math.round(table(level,[1,2,3,4,5])) : 0;
}
export function supportDefense(level:number) {
  return {res:Math.round(table(level,[1,3,5,8,10])), cap:Math.round(table(level,[1,2,3,4,5])),
    regen:table(level,[.2,.4,.6,.8,1])*100, block:Math.round(table(level,[1,3,6,9,12]))};
}

interface Status {
  readyAt: number; activeUntil: number; shield: number;
  nextScan?:number; fearUntil?:number; fearFrom?:Point; curseUntil?:number; phys?:number; fire?:number;
}
export function createSupport120() {
  const states=new WeakMap<object,Status>();
  function state(actor:object) {
    let value=states.get(actor);
    if(!value){value={readyAt:0,activeUntil:0,shield:0};states.set(actor,value);}
    return value;
  }
  function update(actor:Point, id:number, level:number, hp:number, max:number, time:number, nearby:()=>Actor[], emit:SupportEffect) {
    if(!level || hp<=0 || ![710,713,715,716,717].includes(id))return;
    const current=state(actor);
    if(current.readyAt>time)return;
    const fraction=hp/max;
    let duration=0, cooldown=0;
    switch(id){
      case 710:
        duration=6; cooldown=linear(level,30,15); break;
      case 713:
        if(fraction>=.5)return;
        duration=Math.round(linear(level,5,30)); cooldown=linear(level,60,40); break;
      case 715: {
        if((current.nextScan||0)>time)return;
        current.nextScan=time+.2;
        const enemies=nearby().filter(enemy=>!enemy.dead && (enemy.hp??0)>0 &&
          Math.hypot(enemy.x-actor.x,(enemy.y-actor.y)*2)<=fearRadius);
        if(!enemies.length || (enemies.length<3 && fraction>=.4))return;
        duration=Math.round(linear(level,1,4)*10)/10; cooldown=linear(level,45,20);
        for(const enemy of enemies){
          const fear=state(enemy);
          fear.fearUntil=time+duration;fear.fearFrom={x:actor.x,y:actor.y};
          enemy.actionRevision=(enemy.actionRevision||0)+1;
          enemy.castT=0;
        }
        break;
      }
      case 716:
        if(fraction>=.35)return;
        duration=Math.round(linear(level,1,3)*10)/10; cooldown=linear(level,35,15); break;
      case 717:
        if(fraction>=.3)return;
        duration=Math.round(linear(level,5,10)); cooldown=20;
        current.shield=max*Math.round(linear(level,10,40))/100; break;
    }
    current.activeUntil=time+duration;
    current.readyAt=time+cooldown;
    emit(id,actor);
  }
  const active=(actor:object,time:number)=>(states.get(actor)?.activeUntil||0)>time;
  function evades(actor:Point,id:number,level:number,time:number,npc:boolean,random:()=>number,emit:SupportEffect) {
    if(!level)return false;
    if(id===716 && active(actor,time))return true;
    if((id===713 && npc && active(actor,time)) ||
       (id===710 && random()<Math.round(linear(level,5,25))/100)){
      emit(id,actor);return true;
    }
    return false;
  }
  function shield(actor:object,id:number,time:number,damage:number) {
    if(id!==717 || !active(actor,time))return damage;
    const current=state(actor), absorbed=Math.min(current.shield,damage);
    current.shield-=absorbed;
    return damage-absorbed;
  }
  function hit(actor:Point,id:number,level:number,target:Actor,npc:boolean,damage:number,time:number,random:()=>number,emit:SupportEffect) {
    if(!level || damage<=0 || (id!==711 && (id!==714 || !npc)))return 0;
    const source=state(actor);
    if(source.readyAt>time)return 0;
    const chance=Math.round(id===711 ? table(level,[1,4,8,11,15]) : table(level,[1,2,3,5,6]))/100;
    if(random()>=chance)return 0;
    source.readyAt=time+(id===711 ? 10 : 12);
    emit(id,target);
    if(id===711)return damage*Math.round(table(level,[30,42,56,71,85]))/100;
    const curse=state(target);
    curse.phys=Math.round(table(level,[2,4,6,8,10]));
    curse.fire=Math.round(table(level,[3,6,9,12,15]));
    curse.curseUntil=time+Math.round(linear(level,3,9));
    return 0;
  }
  return {update,active,shield,evades,hit,
    reset:(actor:object)=>{
      const current=states.get(actor);
      if(current)states.set(actor,{readyAt:current.readyAt,activeUntil:0,shield:0});
    },
    fear:(actor:object,time:number)=>{const status=states.get(actor);return (status?.fearUntil||0)>time ? status?.fearFrom : undefined;},
    resistance:(actor:object,time:number)=>{const status=states.get(actor);return status?.curseUntil && status.curseUntil>time ? {phys:status.phys!,fire:status.fire!} : null;},
    reflect:(level:number,npc:boolean,damage:number)=>level && npc ? damage*Math.round(table(level,[5,12,22,31,40]))/100 : 0,
    amplify:(actor:object,id:number,level:number,time:number)=>id===710 && level && active(actor,time) ? 1+Math.round(linear(level,20,60))/100 : 1,
    speed:(actor:object,id:number,level:number,time:number)=>id===717 && level && active(actor,time) ? 1+Math.round(linear(level,5,35))/100 : 1,
    immune:(actor:object,id:number,time:number)=>id===716 && active(actor,time)};
}

export function stackSupportPoison(target:Actor,damage:number,seconds:number){
  if(damage<=0 || seconds<=0)return;
  const total=damage+(target.poison||0)*(target.poisonDmg||0);
  target.poison=Math.max(seconds,target.poison||0);
  target.poisonDmg=total/target.poison;
}

const colors:Record<number,string>={708:'#fff4b4',709:'#ffd17b',710:'#aad4ff',711:'#9bd84c',712:'#ffe2fb',713:'#bce7fb',714:'#ff9855',715:'#bd94ef',716:'#fff2aa',717:'#85d2ff'};
export function supportVisual(id:number,point:Point){
  return {k:'ring', x:point.x,y:point.y-8,r:id===715?150:28,life:.62,max:.62,color:colors[id]||'#fff4b4'};
}
