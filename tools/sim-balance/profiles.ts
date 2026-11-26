import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parse } from 'acorn';
import { transformSync } from 'esbuild';
import { createNativeProfileScope } from './native-profile-scope.ts';
import type { FactionBuild, LegacyScope } from './types.ts';

const repositoryRoot = process.cwd();
const equipmentKind = process.argv[3] || 'blue';
const skillTier = Number(process.argv[4] || 90);
if (!['blue','gold','thientu'].includes(equipmentKind) || ![90,150].includes(skillTier)) throw new Error('Choose blue/gold/thientu and skill tier 90/150.');
const outputDirectory = path.resolve(process.argv[2] || '/tmp/vltk-sim-balance');
fs.mkdirSync(outputDirectory, { recursive: true });
const { nativeGlobals, nativeScope, vmContext } = createNativeProfileScope(repositoryRoot);
nativeGlobals.Math.random = () => 0.5; // Identical equipment rolls on each run.
const require = createRequire(import.meta.url); // Existing bundler remains CommonJS.
const { compileTypeScriptEntry } = require('../build-app.js') as typeof import('../build-app.js');
vm.runInContext(compileTypeScriptEntry('simulator/equipment.ts', 'ArmyGear').code, vmContext);
nativeGlobals.createArmyEquipment = nativeGlobals.ArmyGear.createArmyEquipment;
vm.runInContext(compileTypeScriptEntry('simulator/set-equipment.ts', 'ArmySetGear').code, vmContext);
nativeGlobals.applyArmySetEquipment = nativeGlobals.ArmySetGear.applyArmySetEquipment;
vm.runInContext(compileTypeScriptEntry('simulator/war-mounts.ts', 'WarMounts').code, vmContext);
nativeGlobals.chooseWarMount = nativeGlobals.WarMounts.chooseWarMount;
vm.runInContext(compileTypeScriptEntry('simulator/support-skills.ts', 'SupportSkills').code, vmContext);
nativeGlobals.prioritizeLevel60Support = nativeGlobals.SupportSkills.prioritizeLevel60Support;
// Evaluate the native builder without mounting simulator UI. Fail explicitly if
// these function boundaries move so a future refactor cannot silently use a stub.
const runtimeSource = fs.readFileSync(path.join(repositoryRoot, 'src/client/simulator/runtime.ts'), 'utf8');
const builderStart = runtimeSource.indexOf('  function battleProfile(');
const builderEnd = runtimeSource.indexOf('  function spawnBattleActor(', builderStart);
if (builderStart < 0 || builderEnd <= builderStart) throw new Error('Native battlefield profile builder was not found.');
vm.runInContext(transformSync(runtimeSource.slice(builderStart, builderEnd), { loader: 'ts', target: 'es2020' }).code, vmContext);
nativeGlobals.sandbox = {
  createProfile(faction: LegacyScope) {
    const profile = nativeScope.I3();
    return Object.assign(profile, { fac: faction.key, sex: nativeScope.Zt[faction.key] || 0, lvl: 150,
      skPts: 500, attrPts: 745, bkOk: {}, skL: {}, mainLock: true });
  },
};
const builds: FactionBuild[] = [];
for (const factionKey of Object.keys(nativeGlobals.I).filter(factionKey => !nativeGlobals.I[factionKey].novice)) {
  const profile = nativeScope.battleProfile({ team: 'song', faction: factionKey, level: 150, strength: 'normal', count: 1, equipped: true, equipmentKind, skillTier });
  nativeGlobals.o = profile;
  // Offline generation deliberately runs the native optimizers synchronously.
  // Browser recruitment executes these same functions in its Worker.
  nativeScope.Pt(); nativeScope.yt();
  builds.push({ faction: factionKey, name: nativeGlobals.I[factionKey].n, profile, stats: nativeScope.j0() });
}
fs.writeFileSync(path.join(outputDirectory, 'profiles.json'), JSON.stringify({ builds, T: nativeGlobals.T, S: nativeGlobals.S, JFX: nativeGlobals.JFX }));
console.log(`Generated ${builds.length} native builds`);
