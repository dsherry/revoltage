import type { ParamDef, Vec2, Vec3, Zone } from '@sdk';

const num = (v: unknown, fallback: number, min?: number, max?: number): number => {
  let n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
};

const isZone = (z: unknown): z is Zone =>
  !!z && typeof (z as Zone).name === 'string' && Array.isArray((z as Zone).points) &&
  (z as Zone).points.every((p) => Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === 'number'));

export function defaultOf(def: ParamDef): unknown {
  switch (def.type) {
    case 'trigger': return 0;
    case 'xy': return { ...def.default };
    case 'vec3': return { ...def.default };
    case 'input': return def.default ?? '';
    case 'zones': return structuredClone(def.default ?? []);
    default: return def.default;
  }
}

/** Force a stored or incoming value into the schema's shape and range. */
export function coerce(def: ParamDef, v: unknown): unknown {
  switch (def.type) {
    case 'toggle': return typeof v === 'boolean' ? v : def.default;
    case 'number':
    case 'slider': return num(v, def.default, def.min, def.max);
    case 'select': return typeof v === 'string' && def.options.includes(v) ? v : def.default;
    case 'color': return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : def.default;
    case 'trigger': return typeof v === 'number' ? v : 0;
    case 'xy': {
      const o = (v ?? {}) as Partial<Vec2>;
      return { x: num(o.x, def.default.x, def.min, def.max), y: num(o.y, def.default.y, def.min, def.max) };
    }
    case 'vec3': {
      const o = (v ?? {}) as Partial<Vec3>;
      return {
        x: num(o.x, def.default.x, def.min, def.max),
        y: num(o.y, def.default.y, def.min, def.max),
        z: num(o.z, def.default.z, def.min, def.max),
      };
    }
    case 'input': return typeof v === 'string' ? v : def.default ?? '';
    case 'zones':
      return Array.isArray(v)
        ? v.filter(isZone).map((z) => ({ name: z.name, points: z.points.map(([x, y]) => [x, y]) }))
        : structuredClone(def.default ?? []);
  }
}
