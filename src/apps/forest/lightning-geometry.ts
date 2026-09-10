import * as THREE from 'three';

/** Width of the band every pine layer wraps around; wider than any reasonable screen (aspect up to ~2.7). */
export const PINE_SPAN = 6;
const TIERS = 7;
export const VERTS_PER_TREE = 6 + TIERS * 6;
const GROUND_SEGS = 48;
export const GROUND_VERTS = GROUND_SEGS * 6;

export interface PineLayerSpec {
  /** Top of this layer's ground line (scene y). */
  ground: number;
  minH: number;
  maxH: number;
  maxTrees: number;
  seed: number;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One layer of pine silhouettes: a rolling ground strip, then `maxTrees` trees in golden-ratio order, so drawing
 * only the first k trees (drawRange) still spreads them evenly. Positions are relative to each item's own center
 * (aInfo.x), which the vertex shader wraps around PINE_SPAN.
 */
export function buildPineLayer(spec: PineLayerSpec): THREE.BufferGeometry {
  const rand = rng(spec.seed);
  const n = GROUND_VERTS + spec.maxTrees * VERTS_PER_TREE;
  const pos = new Float32Array(n * 3);
  const info = new Float32Array(n * 3);
  let v = 0;
  const put = (x: number, y: number, center: number, edge: number, sway: number) => {
    pos[v * 3] = x;
    pos[v * 3 + 1] = y;
    info[v * 3] = center;
    info[v * 3 + 1] = edge;
    info[v * 3 + 2] = sway;
    v++;
  };

  // Ground: periodic over the span so it wraps without a seam; segments overlap a hair to hide cracks.
  const p1 = rand() * 6.28, p2 = rand() * 6.28;
  const groundY = (x: number) => spec.ground
    + 0.02 * Math.sin((x / PINE_SPAN) * Math.PI * 4 + p1) + 0.01 * Math.sin((x / PINE_SPAN) * Math.PI * 10 + p2);
  const sw = PINE_SPAN / GROUND_SEGS;
  const bottom = -1.3;
  for (let j = 0; j < GROUND_SEGS; j++) {
    const x0 = -PINE_SPAN / 2 + j * sw;
    const cx = x0 + sw / 2;
    const l = -sw / 2 - 0.003, r = sw / 2 + 0.003;
    const yl = groundY(x0), yr = groundY(x0 + sw);
    const e = 0.86;
    put(l, bottom, cx, 0, 0); put(r, bottom, cx, 0, 0); put(r, yr, cx, e, 0);
    put(l, bottom, cx, 0, 0); put(r, yr, cx, e, 0); put(l, yl, cx, e, 0);
  }

  const spacing = PINE_SPAN / spec.maxTrees;
  const offset = rand();
  for (let i = 0; i < spec.maxTrees; i++) {
    const u = (offset + i * 0.6180339887) % 1;
    const cx = (u - 0.5) * PINE_SPAN + (rand() - 0.5) * spacing * 0.6;
    const h = spec.minH + (spec.maxH - spec.minH) * Math.pow(rand(), 0.8);
    const base = groundY(cx) - 0.01 - rand() * 0.03;
    const lean = (rand() - 0.5) * 0.05;
    const tx = (y: number) => (y - base) * lean;
    const sway = (y: number) => Math.max(0, (y - base) / h);

    // Trunk (drawn first so the canopy covers its top).
    const tw = h * 0.022;
    const tb = base - 0.1, tt = base + h * 0.35;
    put(-tw + tx(tb), tb, cx, 0, 0); put(tw + tx(tb), tb, cx, 0, 0); put(tw + tx(tt), tt, cx, 0, sway(tt));
    put(-tw + tx(tb), tb, cx, 0, 0); put(tw + tx(tt), tt, cx, 0, sway(tt)); put(-tw + tx(tt), tt, cx, 0, sway(tt));

    // Tiers bottom to top, each a drooping triangle split at the spine (edge 0 there, 1 on the outline).
    const y0 = base + h * (0.12 + rand() * 0.06), yTop = base + h;
    const ch = yTop - y0;
    for (let k = 0; k < TIERS; k++) {
      const f = k / TIERS;
      const bot = y0 + ch * Math.pow(f, 0.92) * 0.9;
      const apex = k === TIERS - 1 ? yTop : Math.min(yTop, bot + ch * (0.3 + 0.06 * rand()));
      const hw = h * (0.27 * Math.pow(1 - f, 0.95) + 0.03);
      const wl = hw * (0.8 + rand() * 0.4), wr = hw * (0.8 + rand() * 0.4);
      const yl = bot - h * (0.01 + rand() * 0.035), yr = bot - h * (0.01 + rand() * 0.035);
      const yc = bot + h * 0.035;
      const ax = tx(apex), cxo = tx(yc);
      put(ax, apex, cx, 1, sway(apex)); put(-wl + tx(yl), yl, cx, 1, sway(yl)); put(cxo, yc, cx, 0, sway(yc));
      put(ax, apex, cx, 1, sway(apex)); put(cxo, yc, cx, 0, sway(yc)); put(wr + tx(yr), yr, cx, 1, sway(yr));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 3));
  return geo;
}

// --- Lightning bolts: one main channel plus up to three branches, each a quad strip (2 verts per point).
const MAIN_LEVELS = 6;
const BRANCH_LEVELS = 5;
const MAIN_PTS = (1 << MAIN_LEVELS) + 1;
const BRANCH_PTS = (1 << BRANCH_LEVELS) + 1;
const MAX_BRANCHES = 3;
const STRANDS = [MAIN_PTS, BRANCH_PTS, BRANCH_PTS, BRANCH_PTS];
const BOLT_VERTS = (MAIN_PTS + MAX_BRANCHES * BRANCH_PTS) * 2;

/** Preallocated buffers for one bolt; `generate` rewrites them in place (no allocation). */
export class BoltGeometry {
  readonly geometry = new THREE.BufferGeometry();
  private readonly pos = new Float32Array(BOLT_VERTS * 3);
  private readonly nrm = new Float32Array(BOLT_VERTS * 2);
  private readonly data = new Float32Array(BOLT_VERTS * 3);
  private readonly pts = new Float32Array(MAIN_PTS * 2);
  private readonly posAttr = new THREE.BufferAttribute(this.pos, 3);
  private readonly nrmAttr = new THREE.BufferAttribute(this.nrm, 2);
  private readonly dataAttr = new THREE.BufferAttribute(this.data, 3);

  constructor() {
    const idx: number[] = [];
    let base = 0;
    for (const n of STRANDS) {
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
      base += n * 2;
    }
    for (let v = 0; v < BOLT_VERTS; v++) this.pos[v * 3 + 2] = v % 2 === 0 ? -1 : 1;
    this.geometry.setIndex(idx);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aNrm', this.nrmAttr);
    this.geometry.setAttribute('aData', this.dataAttr);
  }

  /** Builds a new bolt from (x0, y0) to (x1, y1) with `branches` side branches (0–3). */
  generate(x0: number, y0: number, x1: number, y1: number, branches: number): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    this.displace(x0, y0, x1, y1, MAIN_LEVELS, len * 0.16);
    this.writeStrand(0, MAIN_PTS, 0, 1, 1, 0.75, 1);

    // Remember the main channel before `pts` is reused for the branches.
    let vBase = MAIN_PTS * 2;
    for (let b = 0; b < MAX_BRANCHES; b++) {
      if (b >= branches) {
        this.collapse(vBase, BRANCH_PTS);
      } else {
        const k = 8 + Math.floor(Math.random() * (MAIN_PTS * 0.62));
        const bx = this.mainX(k), by = this.mainY(k);
        const dx = this.mainX(k + 2) - bx, dy = this.mainY(k + 2) - by;
        const dl = Math.hypot(dx, dy) || 1;
        const ang = (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.55);
        const c = Math.cos(ang), s = Math.sin(ang);
        const bl = len * (1 - k / MAIN_PTS) * (0.25 + Math.random() * 0.3);
        const ex = bx + ((dx * c - dy * s) / dl) * bl, ey = by + ((dx * s + dy * c) / dl) * bl;
        const along = k / (MAIN_PTS - 1);
        this.displace(bx, by, ex, ey, BRANCH_LEVELS, bl * 0.2);
        this.writeStrand(vBase, BRANCH_PTS, along, along + (1 - along) * 0.6, 0.55, 0.12, 0.55 + Math.random() * 0.2);
      }
      vBase += BRANCH_PTS * 2;
    }
    this.posAttr.needsUpdate = true;
    this.nrmAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }

  // The main channel's points are kept in the strand's vertex positions (the average of the two sides).
  private mainX(k: number): number {
    const i = Math.min(k, MAIN_PTS - 1) * 2;
    return this.pos[i * 3];
  }

  private mainY(k: number): number {
    const i = Math.min(k, MAIN_PTS - 1) * 2;
    return this.pos[i * 3 + 1];
  }

  /** Midpoint displacement into `pts`: 2^levels + 1 points. */
  private displace(x0: number, y0: number, x1: number, y1: number, levels: number, amp: number): void {
    const n = 1 << levels;
    const p = this.pts;
    p[0] = x0; p[1] = y0; p[n * 2] = x1; p[n * 2 + 1] = y1;
    let a = amp;
    for (let step = n; step > 1; step >>= 1) {
      const half = step >> 1;
      for (let i = half; i < n; i += step) {
        const ia = (i - half) * 2, ib = (i + half) * 2;
        const ax = p[ia], ay = p[ia + 1], bx = p[ib], by = p[ib + 1];
        const dx = bx - ax, dy = by - ay;
        const d = Math.hypot(dx, dy) || 1;
        const o = (Math.random() * 2 - 1) * a;
        p[i * 2] = (ax + bx) * 0.5 - (dy / d) * o;
        p[i * 2 + 1] = (ay + by) * 0.5 + (dx / d) * o;
      }
      a *= 0.56;
    }
  }

  /** Writes `n` points from `pts` as a strip starting at vertex `vBase`, tapering width from w0 to w1. */
  private writeStrand(vBase: number, n: number, along0: number, along1: number, w0: number, w1: number, bright: number): void {
    const p = this.pts;
    for (let i = 0; i < n; i++) {
      const ia = Math.max(0, i - 1) * 2, ib = Math.min(n - 1, i + 1) * 2;
      const tx = p[ib] - p[ia], ty = p[ib + 1] - p[ia + 1];
      const tl = Math.hypot(tx, ty) || 1;
      const f = i / (n - 1);
      const w = w0 + (w1 - w0) * f;
      for (let side = 0; side < 2; side++) {
        const v = vBase + i * 2 + side;
        this.pos[v * 3] = p[i * 2];
        this.pos[v * 3 + 1] = p[i * 2 + 1];
        this.nrm[v * 2] = -ty / tl;
        this.nrm[v * 2 + 1] = tx / tl;
        this.data[v * 3] = w;
        this.data[v * 3 + 1] = along0 + (along1 - along0) * f;
        this.data[v * 3 + 2] = bright;
      }
    }
  }

  private collapse(vBase: number, n: number): void {
    for (let v = vBase; v < vBase + n * 2; v++) this.data[v * 3] = 0;
  }
}
