import { castSimulatorSkill } from './skill-cast';
import type { LegacyEntity, SimulatorActor, SimulatorSkill } from './types';
import { createSimulator } from './runtime';

// esbuild returns this value directly as the legacy `arenaSimulator` binding.
// Keep the simulator and its shared skill renderer in the same bundle.
function replayBattlefieldSkill(actor: SimulatorActor, target: LegacyEntity, skill: SimulatorSkill, targets:LegacyEntity[]) {
  // The actors are disposable positions. Contact only drives native visual
  // timing and secondary artwork; the server owns every combat result.
  const withCaster = <T>(action:()=>T):T => {
    const previous=v;
    v=actor;
    try { return action(); }
    finally { v=previous; }
  };
  castSimulatorSkill(actor,target,skill,()=>true,()=>targets,()=>1,withCaster,undefined,true);
}

const simulator = Object.assign(createSimulator(), { replayBattlefieldSkill });
declare const module: { exports: typeof simulator };
module.exports = simulator;
