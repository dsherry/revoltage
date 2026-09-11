import { OneEuroFilter } from '1eurofilter';
import type { Hand, Landmark, Person } from '@sdk';

/** CV frames are 16:9; x is scaled by this so distances are isotropic. */
const ASPECT = 16 / 9;
const VIS_MIN = 0.5;
const L_SHOULDER = 11, R_SHOULDER = 12, L_ELBOW = 13, R_ELBOW = 14;
const WRISTS = [15, 16] as const;
/** [pip, tip] of the index, middle, ring and pinky fingers. */
const FINGERS = [[6, 8], [10, 12], [14, 16], [18, 20]] as const;
/** Hands mode follows the wrist and fingertips: a quick hand wave is mostly the fingers sweeping. */
const HAND_POINTS = [0, 4, 8, 12, 16, 20] as const;

/** A hand's new open/closed state must hold this long before it's believed. */
const HAND_SETTLE_MS = 80;
/** A hand unseen for this long counts as gone (so it goes quiet). */
const HAND_LOST_MS = 150;
/** A hand matches a pose wrist within this many body scales. */
const HAND_MATCH = 0.6;
/**
 * Hands mode measures in two hand lengths (4 × wrist to middle knuckle), about a shoulder width,
 * so the swing settings mean roughly the same in both modes.
 */
const HAND_SCALE = 4;
/** 1€ filter speed coefficient, per body scale per second. */
const BETA = 0.7;
/** A swing ends when the movement slows below this fraction of the swing threshold. */
const STOP_RATIO = 0.5;
const MAX_SWING_S = 1;
/** Shortest time between two strings from one arm or hand: tracking jitter can split one movement into several swings. */
const STRING_GAP_S = 0.2;
/** Shortest swing that plays, in body scales. */
export const MIN_SIZE = 0.4;
/** The X must be seen this long before it fires... */
const X_HOLD_MS = 250;
/** ...tolerating dropouts this short. */
const X_GAP_MS = 100;
/** After firing, the X re-arms once it's been gone this long. */
const X_RELEASE_MS = 300;
const TTL_MS = 1000;

export type HandState = 'none' | 'open' | 'closed';
export type TrackMode = 'arms' | 'hands';

export interface GestureOpts {
  /** Swings of arms (pose wrists) or of hands (hand tracking alone). */
  readonly mode: TrackMode;
  /** Speed (body scales per second) a movement needs to count as a swing. */
  readonly minSpeed: number;
  /** Faster than this is a tracking glitch, not a movement: it's ignored. */
  readonly maxSpeed: number;
  /** Position smoothing, 0 (raw) to 1 (heavy). */
  readonly smooth: number;
}

export interface Swing {
  /** 'up' plays an ascending string. */
  readonly dir: 'up' | 'down';
  /** Peak speed in body scales per second. */
  readonly speed: number;
  /** Distance travelled, in body scales. */
  readonly size: number;
  /** The hand was seen open when the swing ended. */
  readonly open: boolean;
  /** Height of the swing's midpoint on screen (normalized image y, 0 = top). */
  readonly y: number;
}

const vis = (p: Landmark): boolean => (p.visibility ?? 0) >= VIS_MIN;
const dist = (a: Landmark, b: Landmark): number => Math.hypot((a.x - b.x) * ASPECT, a.y - b.y);
const dist3 = (a: Landmark, b: Landmark): number => Math.hypot((a.x - b.x) * ASPECT, a.y - b.y, (a.z - b.z) * ASPECT);
/** Smoothing 0..1 → the 1€ filter's minimum cutoff: 10 Hz (nearly raw) down to 0.3 Hz (heavy). */
const minCutoff = (smooth: number): number => 10 ** (1 - 1.5 * Math.min(1, Math.max(0, smooth)));

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

/** One arm's wrist or one tracked hand: the hand's debounced state, and swing detection on its position. */
export class Limb {
  hand: HandState = 'none';
  /** Current speed in body scales per second (for tuning). */
  speed = 0;
  private pending: HandState = 'none';
  private pendingSince = 0;
  private handAt = -Infinity;
  private readonly fx = new OneEuroFilter(30, 1, BETA);
  private readonly fy = new OneEuroFilter(30, 1, BETA);
  private px = 0;
  private py = 0;
  private pt = 0;
  /** Previous height on screen. */
  private pwy = 0;
  private has = false;
  private swing: { sx: number; sy: number; wy: number; dx: number; dy: number; peak: number; t0: number } | null = null;
  /** When this limb last returned a swing (seconds). */
  private firedAt = -Infinity;

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

  /**
   * Feed a position (isotropic screen units), its height on screen (`wy`), the body scale speeds and
   * sizes are measured in, the speed limits, and the smoothing cutoff (Hz); returns a swing when one ends.
   */
  updateMotion(rx: number, ry: number, wy: number, t: number, scale: number, o: GestureOpts, cutoff: number): Swing | null {
    const { minSpeed, maxSpeed } = o;
    this.fx.setMinCutoff(cutoff);
    this.fy.setMinCutoff(cutoff);
    this.fx.setBeta(BETA / scale);
    this.fy.setBeta(BETA / scale);
    const x = this.fx.filter(rx, t), y = this.fy.filter(ry, t);
    const dt = t - this.pt;
    const ok = this.has && dt > 0 && dt < 0.25;
    const px = this.px, py = this.py, pwy = this.pwy;
    this.px = x;
    this.py = y;
    this.pwy = wy;
    this.pt = t;
    this.has = true;
    if (!ok) {
      this.swing = null;
      this.speed = 0;
      return null;
    }
    const vx = (x - px) / dt / scale, vy = (y - py) / dt / scale, speed = Math.hypot(vx, vy);
    if (speed > maxSpeed) {
      // A landmark jumped: drop the swing and start afresh rather than play the glitch.
      this.lose();
      return null;
    }
    this.speed = speed;

    let out: Swing | null = null;
    const s = this.swing;
    if (s) {
      s.peak = Math.max(s.peak, speed);
      const along = speed > 1e-6 ? (vx * s.dx + vy * s.dy) / speed : 0;
      if (speed < minSpeed * STOP_RATIO || along < 0 || t - s.t0 > MAX_SWING_S) {
        this.swing = null;
        const size = Math.hypot(x - s.sx, y - s.sy) / scale;
        if (size >= MIN_SIZE && t - this.firedAt >= STRING_GAP_S) {
          this.firedAt = t;
          out = { dir: y < s.sy ? 'up' : 'down', speed: s.peak, size, open: this.hand === 'open', y: (s.wy + wy) / 2 };
        }
      } else {
        // Follow the arc of the swing, so only a real turnaround ends it.
        const nx = s.dx * 0.6 + (vx / speed) * 0.4, ny = s.dy * 0.6 + (vy / speed) * 0.4;
        const n = Math.hypot(nx, ny) || 1;
        s.dx = nx / n;
        s.dy = ny / n;
      }
    }
    if (!this.swing && speed >= minSpeed) this.swing = { sx: px, sy: py, wy: pwy, dx: vx / speed, dy: vy / speed, peak: speed, t0: t };
    return out;
  }

  /** Out of view: start afresh when it's back. */
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
  readonly arms = [new Limb(), new Limb()] as const;
  /** Shoulder width (or upper arm, if longer), smoothed; normalizes speeds and sizes. */
  scale = 0;
  seen = 0;
}

/** Hands mode: one hand from the hand tracker. */
class TrackedHand {
  readonly limb = new Limb();
  /** Two hand lengths, smoothed. */
  scale = 0;
  /** `seen` of the last hand result used. */
  at = -1;
  /** Centre of the wrist and fingertips (normalized image coords). */
  x = 0;
  y = 0;
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

/** Swings of open hands (via arms or hands alone) and the X "stop" pose. */
export class GestureTracker {
  readonly bodies = new Map<number, Body>();
  /** Hands mode, by hand id. */
  readonly hands = new Map<number, TrackedHand>();
  readonly x = new XDetector();

  /** Call once per new CV result (`now` = its performance.now() time). */
  update(people: readonly Person[], hands: readonly Hand[], now: number, o: GestureOpts): { swings: Swing[]; stop: boolean } {
    const t = now / 1000;
    const cutoff = minCutoff(o.smooth);
    const live: [Body, readonly Landmark[]][] = [];
    const wrists: { arm: Limb; at: Landmark; r: number }[] = [];
    let anyX = false;

    // Bodies are tracked in both modes: the X needs them.
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
    for (const [id, b] of this.bodies) if (now - b.seen > TTL_MS) this.bodies.delete(id);

    let swings: Swing[] = [];
    if (o.mode === 'hands') {
      this.updateHands(hands, now, o, cutoff, swings);
    } else {
      this.matchHands(wrists, hands, now);
      for (const [b, lm] of live) {
        const mx = (lm[L_SHOULDER].x + lm[R_SHOULDER].x) / 2, my = (lm[L_SHOULDER].y + lm[R_SHOULDER].y) / 2;
        for (let i = 0; i < 2; i++) {
          const arm = b.arms[i], w = lm[WRISTS[i]];
          if (!vis(w)) {
            arm.lose();
            continue;
          }
          // Relative to the shoulders, so walking or leaning doesn't read as a swing.
          const s = arm.updateMotion((w.x - mx) * ASPECT, w.y - my, w.y, t, b.scale, o, cutoff);
          if (s) swings.push(s);
        }
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
    for (const h of this.hands.values()) h.limb.cancel();
  }

  /** Arms mode: greedy nearest match of detected hands to pose wrists, for each arm's hand state. */
  private matchHands(wrists: { arm: Limb; at: Landmark; r: number }[], hands: readonly Hand[], now: number): void {
    const pairs: { arm: Limb; hand: Hand; d: number }[] = [];
    for (const w of wrists) {
      for (const h of hands) {
        const d = dist(w.at, h.landmarks[0]);
        if (d < w.r) pairs.push({ arm: w.arm, hand: h, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const matched = new Map<Limb, Hand>();
    const used = new Set<Hand>();
    for (const q of pairs) {
      if (matched.has(q.arm) || used.has(q.hand)) continue;
      matched.set(q.arm, q.hand);
      used.add(q.hand);
    }
    for (const b of this.bodies.values()) for (const a of b.arms) a.updateHand(matched.get(a) ?? null, now);
  }

  /** Hands mode: every tracked hand swings on its own, measured at its wrist and fingertips. */
  private updateHands(hands: readonly Hand[], now: number, o: GestureOpts, cutoff: number, out: Swing[]): void {
    const present = new Set<number>();
    for (const h of hands) {
      present.add(h.id);
      let th = this.hands.get(h.id);
      if (!th) this.hands.set(h.id, (th = new TrackedHand()));
      if (h.seen === th.at) continue; // no new hand result yet (under load hands skip frames)
      th.at = h.seen;
      th.limb.updateHand(h, now);
      const lm = h.landmarks;
      let x = 0, y = 0;
      for (const i of HAND_POINTS) {
        x += lm[i].x;
        y += lm[i].y;
      }
      th.x = x / HAND_POINTS.length;
      th.y = y / HAND_POINTS.length;
      const raw = Math.max(0.01, dist(lm[0], lm[9]) * HAND_SCALE);
      th.scale = th.scale ? th.scale + (raw - th.scale) * 0.1 : raw;
      const s = th.limb.updateMotion(th.x * ASPECT, th.y, th.y, h.seen / 1000, th.scale, o, cutoff);
      if (s) out.push(s);
    }
    for (const [id, th] of this.hands) {
      if (present.has(id)) continue;
      th.limb.updateHand(null, now);
      if (now - th.at > TTL_MS) this.hands.delete(id);
    }
  }
}
