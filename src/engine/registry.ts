import type { AppDef } from '@sdk';
import { log } from './log';

// Every src/apps/<name>/index.ts is an app. Eager, so names and descriptions are known at boot.
const modules = import.meta.glob<AppDef>('../apps/*/index.ts', { eager: true, import: 'default' });

const defs = new Map<string, AppDef>();
for (const [path, def] of Object.entries(modules)) {
  if (!def || typeof def.id !== 'string' || typeof def.setup !== 'function') {
    log('warn', 'registry', `${path} has no valid default export (use defineApp)`);
    continue;
  }
  if (defs.has(def.id)) log('warn', 'registry', `duplicate app id "${def.id}" in ${path}`);
  defs.set(def.id, def);
}

export const registry = {
  list: (): AppDef[] => [...defs.values()].sort((a, b) => a.name.localeCompare(b.name)),
  get: (id: string): AppDef | undefined => defs.get(id),
  /** After a hot update. */
  replace: (def: AppDef): void => { defs.set(def.id, def); },
};
