import type { AppDef, SurfaceKind } from './types';
import { RESERVED_PARAM_NAMES, type ParamSchema } from './params';

export * from './types';
export * from './params';
export * from './util';

/** Define an app. The default export of `src/apps/<name>/index.ts`. */
export function defineApp<const S extends ParamSchema, K extends SurfaceKind>(def: AppDef<S, K>): AppDef<S, K> {
  for (const key of Object.keys(def.params)) {
    if (RESERVED_PARAM_NAMES.includes(key)) throw new Error(`${def.id}: param name "${key}" is reserved`);
  }
  return def;
}
