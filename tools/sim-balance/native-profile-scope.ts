import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { collectLegacyDeclarations } from './legacy-runtime.ts';
import type { LegacyScope } from './types.ts';

export function createNativeProfileScope(repositoryRoot: string) {
  const declarations = collectLegacyDeclarations(path.join(repositoryRoot, 'src/client'));
  const resolvingSymbols = new Set<string>();
  let vmContext: vm.Context;
  // Native j0/Pt/yt access their original shared globals. UI/persistence stubs keep
  // evaluation isolated; native declarations are resolved on first access below.
  const nativeGlobals: LegacyScope = {
    console, Math: Object.create(Math), JSON, Date, Object, Array, Set, Map, WeakMap, WeakSet,
    String, Number, Boolean, RegExp, Infinity, NaN, parseInt, parseFloat, isFinite,
    structuredClone, URL, Uint8Array, Int32Array, Float32Array, ArrayBuffer, Error, TypeError, Promise,
    localStorage: { getItem: () => null, setItem() {} }, combatSandbox: null, arenaSimulator: null,
    document: { querySelector: () => null, createElement: () => ({}), head: { appendChild() {} } },
    m: () => null, nm: () => [], mo: () => ({ dmg: 0 }), Hb() {}, Qb() {},
    l: { sim: true, quiet: true, buffAssume: true }, b: {}, m0: 0,
  };
  nativeGlobals.Math.random = () => 0.5; // Identical equipment rolls on each run.
  const nativeScope = new Proxy(nativeGlobals, {
    get(target, symbolName) {
      if (symbolName in target) return Reflect.get(target, symbolName);
      if (typeof symbolName !== 'string' || resolvingSymbols.has(symbolName)) return undefined;
      const declarationSource = declarations.get(symbolName);
      if (!declarationSource) return undefined;
      resolvingSymbols.add(symbolName);
      try { vm.runInContext(declarationSource, vmContext, { filename: `native:${symbolName}` }); }
      catch (error) { throw new Error(`Native profile declaration ${symbolName} failed`, { cause: error }); }
      finally { resolvingSymbols.delete(symbolName); }
      return target[symbolName];
    },
  });
  vmContext = vm.createContext(nativeScope);
  nativeGlobals.window = nativeGlobals.globalThis = nativeScope;
  vm.runInContext(fs.readFileSync(path.join(repositoryRoot, 'public/data.js'), 'utf8'), vmContext);
  nativeGlobals.S = nativeGlobals.JX;
  nativeGlobals.JFX = { m: {}, c: {}, f: {} };
  nativeGlobals.JW = { mon: {}, anim: {} };
  const catalogFiles = ['equipment-and-zone-patches-01', 'equipment-and-zone-patches-02',
    'projectile-effects-01', 'projectile-effects-02',
    ...Array.from({ length: 59 }, (_, index) => `skill-tables-${String(index + 1).padStart(2, '0')}`),
    'advanced-skills-01', 'skill-150-details-01', 'status-effects-01'];
  for (const catalogName of catalogFiles) vm.runInContext(fs.readFileSync(path.join(repositoryRoot, `src/client/data/${catalogName}.js`), 'utf8'), vmContext);
  for (const skill of Object.values(nativeGlobals.JX.skills) as LegacyScope[]) if (skill.learn === '90') Object.assign(skill, { tier: 90, req: 80 });
  nativeGlobals.T = nativeGlobals.JX.skills;
  nativeGlobals.I = Object.fromEntries((nativeGlobals.JX.factions as LegacyScope[]).filter(faction => faction.skills?.length).map(faction => [faction.key, faction]));
  // Configuration metadata also includes executable initialization outside `var`.
  const configSource = fs.readFileSync(path.join(repositoryRoot, 'src/client/core/helpers-and-config-01.js'), 'utf8');
  for (const statement of parse(configSource, { ecmaVersion: 'latest' }).body) {
    if (statement.type !== 'VariableDeclaration') vm.runInContext(configSource.slice(statement.start, statement.end), vmContext);
  }
  return { nativeGlobals, nativeScope, vmContext };
}
