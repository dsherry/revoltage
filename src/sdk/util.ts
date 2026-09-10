export const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Map v from [inLo, inHi] to [outLo, outHi], clamped by default. */
export function mapRange(v: number, inLo: number, inHi: number, outLo = 0, outHi = 1, clampIt = true): number {
  const t = (v - inLo) / (inHi - inLo || 1);
  return lerp(outLo, outHi, clampIt ? clamp(t) : t);
}

/** Frame-rate-independent exponential smoothing. `tau` is the time constant in seconds. */
export function smoother(tau: number, initial = 0) {
  let v = initial;
  return {
    get value() { return v; },
    update(target: number, dt: number): number {
      v += (target - v) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));
      return v;
    },
    reset(x = 0) { v = x; },
  };
}

/** Returns 'rise' / 'fall' when a boolean changes, else null. */
export function edge() {
  let prev = false;
  return (v: boolean): 'rise' | 'fall' | null => {
    const out = v === prev ? null : v ? 'rise' : 'fall';
    prev = v;
    return out;
  };
}

/** '#rrggbb' → [r, g, b] in 0..255. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** '#rrggbb' → [r, g, b] in 0..1 (for shader uniforms). */
export function hexToRgb01(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** h, s, v in 0..1 → [r, g, b] in 0..1. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
