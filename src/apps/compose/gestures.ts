import { OneEuroFilter } from '1eurofilter';
import type { Hand, Landmark, Person } from '@sdk';

/** CV frames are 16:9; x is scaled by this so distances are isotropic. */
const ASPECT = 16 / 9;
const VIS_MIN = 0.5;
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14;
const WRISTS = [15, 16] as const;
/** [pip, tip] of the index, middle, ring and pinky fingers. */
const FINGERS = [[6, 8], [10, 12], [14, 16], [18, 20]] as const;

/** A hand's new open/closed state must hold this long before it's believed. */
const HAND_SETTLE_MS = 80;
/** A hand unseen for this long counts as gone (so its arm goes quiet). */
const HAND_LOST_MS = 150;
/** A hand matches a pose wrist within this many body scales. */
const HAND_MATCH = 0.6;
/** A swing ends when the wrist slows below this fraction of the swing threshold. */
const STOP_RATIO = 0.5;
const MAX_SWING_S = 1;
/** Shortest swing that plays, in body scales. */
export const MIN_SIZE = 0.4;
/** The X must be seen this long before it fires... */
const X_HOLD_MS = 250;
/** ...tolerating dropouts this short. */
const X_GAP_MS = 100;
/** After firing, the X re-arms once it's been gone this long. */
const X_RELEASE_MS = 300;
const BODY_TTL_MS = 1000;

export type HandState = 'none' | 'open' | 'closed';

export interface Swing {
  /** 'up' plays an ascending string. */
  readonly dir: 'up' | 'down';
  /** Peak wrist speed in body scales per second. */
  readonly speed: number;
  /** Distance the wrist travelled, in body scales. */
  readonly size: number;
  /** The arm's hand was seen open when the swing ended. */
  readonly open: boolean;
}

const vis = (p: Landmark): boolean => (p.visibility ?? 0) >= VIS_MIN;
const dist = (a: Landmark, b: Landmark): number => Math.hypot((a.x - b.x) * ASPECT, a.y - b.y);
const dist3 = (a: Landmark, b: Landmark): number => Math.hypot((a.x - b.x) * ASPECT, a.y - b.y, (a.z - b.z) * ASPECT);

/** What this frame's hand looks like: open, closed, or ambiguous ('none'). */
function handVote(h: Hand): HandState {
  if (h.gesture.name === 'Open_Palm') return 'open';
  if (h.gesture.name === 'Closed_Fist') return 'closed';
  // The classifier often says 'None' for hands seen edge-on or mid-motion: count straight fingers.
  const lm = h.landmarks, w = lm[0];
  let straight = 0;
  for (const [pip, tip] of FINGERS) if (dist3(w, lm[tip]) > 1.1 * dist3(w, lm[pip])) straight++;
  return straight >= 3 ? 'open' : straight <= 1 ? 'closed' : 'none';
}

/** Forearms crossed with the wrists above the elbows (so folded arms don't count). */
function crossed(lm: readonly Landmark[]): boolean {
  const le = lm[L_ELBOW], re = lm[R_ELBOW], lw = lm[WRISTS[0]], rw = lm[WRISTS[1]];
  if (!vis(le) || !vis(re) || !vis(lw) || !vis(rw)) return false;
  if (lw.y >= le.y || rw.y >= re.y) return false;
  // Extend each forearm a little past the wrist to take in the hand.
  const reach = (a: Landmark, b: Landmark): Landmark => ({ x: b.x + (b.x - a.x) * 0.3, y: b.y + (b.y - a.y) * 0.3, z: 0 });
  const side = (p: Landmark, q: Landmark, r: Landmark): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const a = le, b = reach(le, lw), c = re, d = reach(re, rw);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** One arm: its hand's debounced state, and swing detection on its wrist. */
export class Arm {
  hand: HandState = 'none';
  /** Current wrist speed in body scales per second (for tuning). */
  speed = 0;
  private pending: HandState = 'none';
  private pendingSince = 0;
  private handAt = -Infinity;
  private readonly fx = new OneEuroFilter(30, 1, 0.7);
  private readonly fy = new OneEuroFilter(30, 1, 0.7);
  private px = 0;
  private py = 0;
  private pt = 0;
  private has = false;
  private swing: { sx: number; sy: number; dx: number; dy: number; peak: number; t0: number } | null = null;

  updateHand(h: Hand | null, now: number): void {
    if (!h) {
      if (now - this.handAt > HAND_LOST_MS) this.hand = this.pending = 'none';
      return;
    }
    this.handAt = now;
    const v = handVote(h);
    if (v === 'none' || v === this.hand) {
      this.pending = this.hand;
      return;
    }
    if (v !== this.pending) {
      this.pending = v;
      this.pendingSince = now;
    }
    if (now - this.pendingSince >= HAND_SETTLE_MS) this.hand = v;
  }

  /** Feed the wrist position relative to the shoulders (body scales); returns a swing when one ends. */
  updateMotion(rx: number, ry: number, t: number, minSpeed: number): Swing | null {
    const x = this.fx.filter(rx, t), y = this.fy.filter(ry, t);
    const dt = t - this.pt;
    const ok = this.has && dt > 0 && dt < 0.25;
    const px = this.px, py = this.py;
    this.px = x;
    this.py = y;
    this.pt = t;
    this.has = true;
    if (!ok) {
      this.swing = null;
      this.speed = 0;
      return null;
    }
    const vx = (x - px) / dt, vy = (y - py) / dt, speed = Math.hypot(vx, vy);
    this.speed = speed;

    let out: Swing | null = null;
    const s = this.swing;
    if (s) {
      s.peak = Math.max(s.peak, speed);
      const along = speed > 1e-6 ? (vx * s.dx + vy * s.dy) / speed : 0;
      if (speed < minSpeed * STOP_RATIO || along < 0 || t - s.t0 > MAX_SWING_S) {
        this.swing = null;
        const size = Math.hypot(x - s.sx, y - s.sy);
        if (size >= MIN_SIZE) out = { dir: y < s.sy ? 'up' : 'down', speed: s.peak, size, open: this.hand === 'open' };
      } else {
        // Follow the arc of the swing, so only a real turnaround ends it.
        const nx = s.dx * 0.6 + (vx / speed) * 0.4, ny = s.dy * 0.6 + (vy / speed) * 0.4;
        const n = Math.hypot(nx, ny) || 1;
        s.dx = nx / n;
        s.dy = ny / n;
      }
    }
    if (!this.swing && speed >= minSpeed) this.swing = { sx: px, sy: py, dx: vx / speed, dy: vy / speed, peak: speed, t0: t };
    return out;
  }

  /** Wrist or shoulders out of view: start afresh when they're back. */
  lose(): void {
    this.has = false;
    this.swing = null;
    this.speed = 0;
    this.fx.reset();
    this.fy.reset();
  }

  cancel(): void {
    this.swing = null;
  }
}

class Body {
  /** Left, right (the person's own). */
  readonly arms = [new Arm(), new Arm()] as const;
  /** Shoulder width (or upper arm, if longer), smoothed; normalizes speeds and sizes. */
  scale = 0;
  seen = 0;
}

/** Latches once an X has been held for X_HOLD_MS; re-arms after it's released. */
class XDetector {
  latched = false;
  private since = -1;
  private lastSeen = -Infinity;

  /** True on the update the X fires. */
  update(seen: boolean, now: number): boolean {
    if (seen) {
      if (this.since < 0) this.since = now;
      this.lastSeen = now;
    } else if (now - this.lastSeen > X_GAP_MS) {
      this.since = -1;
    }
    if (this.latched) {
      if (now - this.lastSeen > X_RELEASE_MS) this.latched = false;
      return false;
    }
    if (this.since >= 0 && now - this.since >= X_HOLD_MS) {
      this.latched = true;
      return true;
    }
    return false;
  }

  /** An X is forming or held: don't start new strings. */
  get active(): boolean {
    return this.latched || this.since >= 0;
  }
}

/** Swings of open-handed arms and the X "stop" pose, from pose + hand tracking. */
export class GestureTracker {
  readonly bodies = new Map<number, Body>();
  readonly x = new XDetector();

  /** Call once per new CV result (`now` = its performance.now() time). */
  update(people: readonly Person[], hands: readonly Hand[], now: number, minSpeed: number): { swings: Swing[]; stop: boolean } {
    const t = now / 1000;
    const live: [Body, readonly Landmark[]][] = [];
    const wrists: { arm: Arm; at: Landmark; r: number }[] = [];
    let anyX = false;

    for (const p of people) {
      let b = this.bodies.get(p.id);
      if (!b) this.bodies.set(p.id, (b = new Body()));
      b.seen = now;
      const lm = p.landmarks;
      if (crossed(lm)) anyX = true;
      const ls = lm[L_SHOULDER], rs = lm[R_SHOULDER];
      if (!vis(ls) || !vis(rs)) {
        for (const a of b.arms) a.lose();
        continue;
      }
      let raw = dist(ls, rs);
      if (vis(lm[L_ELBOW]) && vis(lm[R_ELBOW])) raw = Math.max(raw, (dist(ls, lm[L_ELBOW]) + dist(rs, lm[R_ELBOW])) / 2);
      raw = Math.max(0.02, raw);
      b.scale = b.scale ? b.scale + (raw - b.scale) * 0.1 : raw;
      live.push([b, lm]);
      for (let i = 0; i < 2; i++) {
        const w = lm[WRISTS[i]];
        if (vis(w)) wrists.push({ arm: b.arms[i], at: w, r: HAND_MATCH * b.scale });
      }
    }
    for (const [id, b] of this.bodies) if (now - b.seen > BODY_TTL_MS) this.bodies.delete(id);

    // Greedy nearest match of detected hands to pose wrists.
    const pairs: { arm: Arm; hand: Hand; d: number }[] = [];
    for (const w of wrists) {
      for (const h of hands) {
        const d = dist(w.at, h.landmarks[0]);
        if (d < w.r) pairs.push({ arm: w.arm, hand: h, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const matched = new Map<Arm, Hand>();
    const used = new Set<Hand>();
    for (const q of pairs) {
      if (matched.has(q.arm) || used.has(q.hand)) continue;
      matched.set(q.arm, q.hand);
      used.add(q.hand);
    }
    for (const b of this.bodies.values()) for (const a of b.arms) a.updateHand(matched.get(a) ?? null, now);

    let swings: Swing[] = [];
    for (const [b, lm] of live) {
      const mx = (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, my = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
      for (let i = 0; i < 2; i++) {
        const arm = b.arms[i], w = lm[WRISTS[i]];
        if (!vis(w)) {
          arm.lose();
          continue;
        }
        // Relative to the shoulders, so walking or leaning doesn't read as a swing.
        const s = arm.updateMotion(((w.x - mx) * ASPECT) / b.scale, (w.y - my) / b.scale, t, minSpeed);
        if (s) swings.push(s);
      }
    }

    const stop = this.x.update(anyX, now);
    if (stop) this.cancel();
    if (this.x.active) swings = [];
    return { swings, stop };
  }

  /** Drop swings in progress (after a stop). */
  cancel(): void {
    for (const b of this.bodies.values()) for (const a of b.arms) a.cancel();
  }
}
