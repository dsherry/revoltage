import type { GestureName, Hand, Landmark, Person, Rect, Vec2 } from '@sdk';
import type { HandResult } from './cv.worker';

/** CV frames are 640×360; distances are measured with x scaled to be isotropic. */
const ASPECT = 16 / 9;
const POSE_N = 33;
const HAND_N = 21;
/** Shoulders, elbows, wrists, hips, knees, ankles. */
const BODY_IDX = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
/** Wrist and fingertips. */
const HAND_IDX = [0, 4, 8, 12, 16, 20];
const MAX_MATCH_DIST = 0.2;
const PERSON_TTL = 500;
const HAND_TTL = 300;
const VIS_MIN = 0.5;
/** Speed smoothing time constant (s). */
const TAU = 0.15;
const MAX_DETECTIONS = 16;
const GESTURES: readonly GestureName[] = ['None', 'Closed_Fist', 'Open_Palm', 'Pointing_Up', 'Thumb_Down', 'Thumb_Up', 'Victory', 'ILoveYou'];

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot((ax - bx) * ASPECT, ay - by);
const newLandmarks = (n: number, vis: boolean): Landmark[] =>
  Array.from({ length: n }, () => (vis ? { x: 0, y: 0, z: 0, visibility: 0 } : { x: 0, y: 0, z: 0 }));

interface Track {
  seen: number;
  readonly center: Vec2;
  readonly prev: Float32Array;
  hasPrev: boolean;
}

/**
 * Greedy nearest-centre matching of detections (centres in `dc`) to live tracks.
 * Writes the matched track index (or -1) per detection into `out`.
 */
function match(dc: Float32Array, n: number, tracks: readonly Track[], out: Int32Array, taken: Uint8Array): void {
  out.fill(-1, 0, n);
  taken.fill(0, 0, tracks.length);
  for (;;) {
    let best = MAX_MATCH_DIST, bd = -1, bt = -1;
    for (let d = 0; d < n; d++) {
      if (out[d] >= 0) continue;
      for (let t = 0; t < tracks.length; t++) {
        if (taken[t]) continue;
        const dd = dist(dc[d * 2], dc[d * 2 + 1], tracks[t].center.x, tracks[t].center.y);
        if (dd < best) { best = dd; bd = d; bt = t; }
      }
    }
    if (bd < 0) return;
    out[bd] = bt;
    taken[bt] = 1;
  }
}

class PersonTrack implements Person, Track {
  readonly landmarks = newLandmarks(POSE_N, true);
  readonly bbox: Rect = { x: 0, y: 0, w: 0, h: 0 };
  readonly center: Vec2 = { x: 0, y: 0 };
  speed = 0;
  seen = 0;
  readonly prev = new Float32Array(BODY_IDX.length * 2);
  readonly prevOk = new Uint8Array(BODY_IDX.length);
  hasPrev = false;
  constructor(readonly id: number) {}
}

/** Stable person ids and speeds from raw pose results. */
export class PersonTracker {
  /** People detected in the latest result (objects are reused while a person stays tracked). */
  readonly people: PersonTrack[] = [];
  private tracks: PersonTrack[] = [];
  private nextId = 1;
  private updatedAt = 0;
  private readonly dc = new Float32Array(MAX_DETECTIONS * 2);
  private readonly assign = new Int32Array(MAX_DETECTIONS);
  private readonly taken = new Uint8Array(64);

  update(data: Float32Array, count: number, now: number, mirrored: boolean): void {
    const n = Math.min(count, MAX_DETECTIONS);
    for (let d = 0; d < n; d++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let pass = 0; pass < 2 && x0 === Infinity; pass++) {
        for (let i = 0; i < POSE_N; i++) {
          const o = (d * POSE_N + i) * 4;
          if (pass === 0 && data[o + 3] < VIS_MIN) continue;
          const x = mirrored ? 1 - data[o] : data[o], y = data[o + 1];
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
      this.dc[d * 2] = (x0 + x1) / 2;
      this.dc[d * 2 + 1] = (y0 + y1) / 2;
    }
    this.tracks = this.tracks.filter((t) => now - t.seen <= PERSON_TTL);
    if (this.tracks.length > this.taken.length) this.tracks.length = this.taken.length;
    match(this.dc, n, this.tracks, this.assign, this.taken);

    this.people.length = 0;
    for (let d = 0; d < n; d++) {
      let t = this.assign[d] >= 0 ? this.tracks[this.assign[d]] : null;
      if (!t) {
        t = new PersonTrack(this.nextId++);
        this.tracks.push(t);
      }
      this.fill(t, data, d, now, mirrored);
      this.people.push(t);
    }
    this.updatedAt = now;
  }

  /** Forget people when results stop arriving (pose unsubscribed, camera gone). */
  expire(now: number): void {
    if (this.people.length && now - this.updatedAt > PERSON_TTL) this.people.length = 0;
  }

  reset(): void {
    this.people.length = 0;
    this.tracks = [];
  }

  private fill(t: PersonTrack, data: Float32Array, d: number, now: number, mirrored: boolean): void {
    const lm = t.landmarks;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < POSE_N; i++) {
      const o = (d * POSE_N + i) * 4;
      const p = lm[i];
      p.x = mirrored ? 1 - data[o] : data[o];
      p.y = data[o + 1];
      p.z = data[o + 2];
      p.visibility = data[o + 3];
      if (p.visibility >= VIS_MIN) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
    }
    if (x0 === Infinity) { x0 = x1 = this.dc[d * 2]; y0 = y1 = this.dc[d * 2 + 1]; }
    t.bbox.x = x0; t.bbox.y = y0; t.bbox.w = x1 - x0; t.bbox.h = y1 - y0;
    t.center.x = this.dc[d * 2];
    t.center.y = this.dc[d * 2 + 1];

    // Body height ≈ 3 × shoulder-mid to hip-mid.
    const sx = (lm[11].x + lm[12].x) / 2, sy = (lm[11].y + lm[12].y) / 2;
    const hx = (lm[23].x + lm[24].x) / 2, hy = (lm[23].y + lm[24].y) / 2;
    const height = Math.max(0.05, dist(sx, sy, hx, hy) * 3);
    const dt = (now - t.seen) / 1000;
    let sum = 0, cnt = 0;
    for (let k = 0; k < BODY_IDX.length; k++) {
      const p = lm[BODY_IDX[k]];
      const ok = (p.visibility ?? 0) >= VIS_MIN;
      if (ok && t.prevOk[k] && t.hasPrev) { sum += dist(p.x, p.y, t.prev[k * 2], t.prev[k * 2 + 1]); cnt++; }
      t.prev[k * 2] = p.x;
      t.prev[k * 2 + 1] = p.y;
      t.prevOk[k] = ok ? 1 : 0;
    }
    if (t.hasPrev && dt > 0 && dt < 0.5) {
      const inst = cnt ? sum / cnt / dt / height : 0;
      t.speed += (inst - t.speed) * (1 - Math.exp(-dt / TAU));
    }
    t.hasPrev = true;
    t.seen = now;
  }
}

class HandTrack implements Hand, Track {
  handedness: 'Left' | 'Right' = 'Right';
  readonly landmarks = newLandmarks(HAND_N, false);
  speed = 0;
  readonly gesture: { name: GestureName; score: number } = { name: 'None', score: 0 };
  seen = 0;
  readonly center: Vec2 = { x: 0, y: 0 };
  readonly prev = new Float32Array(HAND_IDX.length * 2);
  hasPrev = false;
  constructor(readonly id: number) {}
}

/** Hand speeds (hand-lengths per second) by matching wrists across results. */
export class HandTracker {
  readonly hands: HandTrack[] = [];
  private tracks: HandTrack[] = [];
  private nextId = 1;
  private updatedAt = 0;
  private readonly dc = new Float32Array(MAX_DETECTIONS * 2);
  private readonly assign = new Int32Array(MAX_DETECTIONS);
  private readonly taken = new Uint8Array(64);

  update(r: HandResult, now: number, mirrored: boolean): void {
    const n = Math.min(r.n, MAX_DETECTIONS);
    for (let h = 0; h < n; h++) {
      const o = h * HAND_N * 3;
      this.dc[h * 2] = mirrored ? 1 - r.data[o] : r.data[o];
      this.dc[h * 2 + 1] = r.data[o + 1];
    }
    this.tracks = this.tracks.filter((t) => now - t.seen <= HAND_TTL);
    if (this.tracks.length > this.taken.length) this.tracks.length = this.taken.length;
    match(this.dc, n, this.tracks, this.assign, this.taken);

    this.hands.length = 0;
    for (let h = 0; h < n; h++) {
      let t = this.assign[h] >= 0 ? this.tracks[this.assign[h]] : null;
      if (!t) {
        t = new HandTrack(this.nextId++);
        this.tracks.push(t);
      }
      this.fill(t, r, h, now, mirrored);
      this.hands.push(t);
    }
    this.updatedAt = now;
  }

  expire(now: number): void {
    if (this.hands.length && now - this.updatedAt > HAND_TTL) this.hands.length = 0;
  }

  reset(): void {
    this.hands.length = 0;
    this.tracks = [];
  }

  private fill(t: HandTrack, r: HandResult, h: number, now: number, mirrored: boolean): void {
    const lm = t.landmarks;
    for (let i = 0; i < HAND_N; i++) {
      const o = (h * HAND_N + i) * 3;
      const p = lm[i];
      p.x = mirrored ? 1 - r.data[o] : r.data[o];
      p.y = r.data[o + 1];
      p.z = r.data[o + 2];
    }
    // MediaPipe labels handedness as if the image were mirrored; our frames never are.
    t.handedness = r.handedness[h] === 'Left' ? 'Right' : 'Left';
    const g = r.gestures[h] as GestureName;
    t.gesture.name = GESTURES.includes(g) ? g : 'None';
    t.gesture.score = r.scores[h] ?? 0;
    t.center.x = lm[0].x;
    t.center.y = lm[0].y;

    // Hand length ≈ 2 × wrist to middle-finger knuckle.
    const size = Math.max(0.02, dist(lm[0].x, lm[0].y, lm[9].x, lm[9].y) * 2);
    const dt = (now - t.seen) / 1000;
    let sum = 0;
    for (let k = 0; k < HAND_IDX.length; k++) {
      const p = lm[HAND_IDX[k]];
      if (t.hasPrev) sum += dist(p.x, p.y, t.prev[k * 2], t.prev[k * 2 + 1]);
      t.prev[k * 2] = p.x;
      t.prev[k * 2 + 1] = p.y;
    }
    if (t.hasPrev && dt > 0 && dt < 0.5) {
      const inst = sum / HAND_IDX.length / dt / size;
      t.speed += (inst - t.speed) * (1 - Math.exp(-dt / TAU));
    }
    t.hasPrev = true;
    t.seen = now;
  }
}
