import type { Zone } from '@sdk';

/** Zone motion runs on a tiny luminance grid; 160×90 keeps it well under a millisecond. */
export const ZW = 160;
export const ZH = 90;
const BG_RATE = 0.05;
const DIFF_THRESHOLD = 20;
/** Hysteresis on the smoothed motion fraction. */
const ON = 0.08;
const OFF = 0.04;
const SMOOTH = 0.4;

/** Per-zone-set results, as posted from the worker (`since` is epoch ms). */
export interface ZoneSetResult {
  id: number;
  names: string[];
  motion: Float32Array;
  active: Uint8Array;
  since: Float64Array;
}

interface CompiledSet extends ZoneSetResult {
  key: string;
  pixels: Uint32Array[];
}

function inside(pts: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Grid pixel indices whose centres fall inside a normalized polygon. */
export function rasterize(points: readonly (readonly [number, number])[]): Uint32Array {
  if (points.length < 3) return new Uint32Array(0);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const gx0 = Math.max(0, Math.floor(x0 * ZW)), gx1 = Math.min(ZW - 1, Math.ceil(x1 * ZW));
  const gy0 = Math.max(0, Math.floor(y0 * ZH)), gy1 = Math.min(ZH - 1, Math.ceil(y1 * ZH));
  const out: number[] = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      if (inside(points, (gx + 0.5) / ZW, (gy + 0.5) / ZH)) out.push(gy * ZW + gx);
    }
  }
  return Uint32Array.from(out);
}

/**
 * Frame differencing against a running background, measured per zone.
 * One instance per camera (lives in the CV worker); zone sets are keyed by subscriber id.
 */
export class ZoneDiffer {
  /** Whole-frame changed fraction, smoothed. */
  activity = 0;
  private readonly g: OffscreenCanvasRenderingContext2D;
  private readonly bg = new Float32Array(ZW * ZH);
  private readonly changed = new Uint8Array(ZW * ZH);
  private primed = false;
  private readonly sets = new Map<number, CompiledSet>();

  constructor() {
    const g = new OffscreenCanvas(ZW, ZH).getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('no 2D context for zone motion');
    this.g = g;
  }

  /** Replace one subscriber's zones (null removes them). Keeps state for zones whose name is unchanged. */
  setZones(id: number, zones: readonly Zone[] | null, nowEpoch: number): void {
    if (!zones?.length) { this.sets.delete(id); return; }
    const key = JSON.stringify(zones);
    const prev = this.sets.get(id);
    if (prev?.key === key) return;
    const n = zones.length;
    const set: CompiledSet = {
      id, key,
      names: zones.map((z) => z.name),
      pixels: zones.map((z) => rasterize(z.points)),
      motion: new Float32Array(n),
      active: new Uint8Array(n),
      since: new Float64Array(n).fill(nowEpoch),
    };
    if (prev) {
      set.names.forEach((name, i) => {
        const j = prev.names.indexOf(name);
        if (j < 0) return;
        set.motion[i] = prev.motion[j];
        set.active[i] = prev.active[j];
        set.since[i] = prev.since[j];
      });
    }
    this.sets.set(id, set);
  }

  /** Drop zone sets whose subscriber is gone. */
  retain(ids: ReadonlySet<number>): void {
    for (const id of this.sets.keys()) if (!ids.has(id)) this.sets.delete(id);
  }

  process(frame: CanvasImageSource, nowEpoch: number): void {
    const { g, bg, changed } = this;
    g.drawImage(frame, 0, 0, ZW, ZH);
    const px = g.getImageData(0, 0, ZW, ZH).data;
    let count = 0;
    for (let i = 0, p = 0; i < ZW * ZH; i++, p += 4) {
      const lum = (px[p] * 77 + px[p + 1] * 150 + px[p + 2] * 29) >> 8;
      if (!this.primed) bg[i] = lum;
      const d = lum - bg[i];
      bg[i] += BG_RATE * d;
      const c = d > DIFF_THRESHOLD || d < -DIFF_THRESHOLD ? 1 : 0;
      changed[i] = c;
      count += c;
    }
    this.primed = true;
    this.activity += (count / (ZW * ZH) - this.activity) * SMOOTH;

    for (const s of this.sets.values()) {
      for (let k = 0; k < s.pixels.length; k++) {
        const idx = s.pixels[k];
        let c = 0;
        for (let j = 0; j < idx.length; j++) c += changed[idx[j]];
        const raw = idx.length ? c / idx.length : 0;
        const m = (s.motion[k] += (raw - s.motion[k]) * SMOOTH);
        if (!s.active[k] && m > ON) { s.active[k] = 1; s.since[k] = nowEpoch; }
        else if (s.active[k] && m < OFF) { s.active[k] = 0; s.since[k] = nowEpoch; }
      }
    }
  }

  /** Current results (postMessage clones them). */
  results(): ZoneSetResult[] {
    const out: ZoneSetResult[] = [];
    for (const s of this.sets.values()) out.push({ id: s.id, names: s.names, motion: s.motion, active: s.active, since: s.since });
    return out;
  }
}
