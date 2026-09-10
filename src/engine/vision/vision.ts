import type {
  Hand, InputKind, Mask, Person, TrackOpts, VisionAPI, VisionHandle, Zone, ZoneState,
} from '@sdk';
import { resolveSource, type ParamReader, type VisionService } from '../services';
import type { Scope } from '../scope';
import { findByName, shortNameFor, SHORT_NAMES } from '../devices';
import { load, save } from '../persist';
import { log } from '../log';
import { CameraRegistry, type Camera } from './cameras';
import { HandTracker, PersonTracker } from './tracker';
import type { CvConfig, CvResult, FromWorker, TaskKind, TaskStatus, ToWorker } from './cv.worker';
import type { ZoneSetResult } from './zones';

/** UI-facing snapshot of one camera (Cameras panel). */
export interface CameraInfo {
  readonly name: string;
  readonly label: string;
  readonly connected: boolean;
  readonly width: number;
  readonly height: number;
  /** Frames actually delivered per second (measured). */
  readonly fps: number;
  readonly mirrored: boolean;
  readonly cvFps: number;
  /** Capture → result, smoothed. */
  readonly cvLatencyMs: number;
  /** Time the worker spends per frame, smoothed. */
  readonly cvWorkerMs: number;
  /** 0 = everything every frame, 1 = hands every 2nd frame, 2 = also mask every 3rd. */
  readonly degrade: number;
  /** What subscribers want right now, e.g. ['pose-lite', 'hands', 'zones×3']. */
  readonly activeTasks: string[];
  /** Model status, e.g. ['pose-lite: GPU', 'mask: loading']. */
  readonly tasks: string[];
  /** 'GPU', 'CPU', 'GPU+CPU' or '—' (nothing loaded yet). */
  readonly delegate: string;
  readonly subscribers: number;
  readonly error: string | null;
}

interface MutableZoneState { motion: number; active: boolean; since: number }
interface ZoneRecord { names: string[]; states: Record<string, MutableZoneState> }

/** Per-camera state; survives unplug/replug (keyed by the registry's Camera, i.e. its label). */
interface Cam {
  readonly label: string;
  readonly dev: Camera;
  readonly name: string;
  mirrored: boolean;
  /** The stream the frame pump is armed on. */
  stream: MediaStream | null;
  worker: Worker | null;
  restartAt: number;
  busy: boolean;
  busySince: number;
  captureT: number;
  seq: number;
  config: CvConfig;
  configKey: string;
  subs: number;
  rvfc: number;
  rvfcAt: number;
  lastPump: number;
  statT0: number;
  statFrames: number;
  statVideo: number;
  statQuality: number;
  videoFps: number;
  cvFps: number;
  latencyMs: number;
  workerMs: number;
  degrade: number;
  tasks: Partial<Record<TaskKind, TaskStatus>>;
  error: string | null;
  readonly tracker: PersonTracker;
  readonly handTracker: HandTracker;
  mask: Mask | null;
  maskAt: number;
  readonly oldMasks: ImageBitmap[];
  readonly zones: Map<number, ZoneRecord>;
  activity: number;
  updatedAt: number;
}

/** One `track()` call. */
interface Sub {
  readonly id: number;
  name: string;
  readonly pose: { model: 'lite' | 'full'; maxPeople: number } | null;
  readonly hands: { maxHands: number } | null;
  readonly mask: boolean;
  zones: Zone[];
  cam: Cam | null;
}

const FRAME_W = 640;
const FRAME_H = 360;
const WARM: TaskKind[] = ['pose-lite', 'hands'];
const WATCHDOG_MS = 10_000;
const RESTART_MIN_MS = 30_000;
/** If requestVideoFrameCallback goes quiet (hidden window, off-DOM video), pump from timers. */
const RVFC_SILENT_MS = 150;
const MIN_PUMP_MS = 30;
const MASK_STALE_MS = 1000;
const EMPTY_CONFIG: CvConfig = { pose: null, hands: null, mask: false, zones: [] };
const NONE: readonly never[] = Object.freeze([]);
const NO_ZONES: Readonly<Record<string, ZoneState>> = Object.freeze({});

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def;
  return Math.min(max, Math.max(min, n));
}

const isZone = (z: unknown): z is Zone =>
  !!z && typeof (z as Zone).name === 'string' && Array.isArray((z as Zone).points) && (z as Zone).points.length >= 3 &&
  (z as Zone).points.every((p) => Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === 'number' && Number.isFinite(c)));

const asZones = (v: unknown): Zone[] => (Array.isArray(v) ? v.filter(isZone) : []);

const flipZones = (zones: readonly Zone[]): Zone[] =>
  zones.map((z) => ({ name: z.name, points: z.points.map(([x, y]): [number, number] => [1 - x, y]) }));

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function activeTasks(cfg: CvConfig): string[] {
  const out: string[] = [];
  if (cfg.pose) out.push(`pose-${cfg.pose.model}`);
  if (cfg.hands) out.push('hands');
  if (cfg.mask) out.push('mask');
  if (cfg.zones.length) out.push(`zones×${cfg.zones.reduce((n, z) => n + z.zones.length, 0)}`);
  return out;
}

/**
 * Cameras → per-camera CV workers → tracker → handles.
 *
 * Frames flow only while a camera has subscribers and its worker is idle (never queued).
 * Everything an app acquires is released through its scope.
 */
export class VisionEngine implements VisionService {
  readonly registry = new CameraRegistry();
  status: 'idle' | 'starting' | 'running' | 'offline' = 'idle';
  onChange: () => void = () => {};

  private readonly cams: Cam[] = [];
  private readonly subs = new Set<Sub>();
  private nextSubId = 1;
  private timer = 0;

  /** Opens cameras (awaited) and spawns workers; model warm-up continues in the background. */
  async start(): Promise<void> {
    if (this.status !== 'idle') return;
    this.status = 'starting';
    this.onChange();
    this.registry.onChange = () => this.devicesChanged();
    try {
      await this.registry.start();
    } catch (e) {
      log('error', 'vision', 'camera setup failed; vision is offline', e);
    }
    this.status = 'running';
    this.devicesChanged();
    this.timer = window.setInterval(() => this.housekeeping(performance.now()), 33);
    const live = this.cams.filter((c) => c.dev.connected);
    if (live.length) log('info', 'vision', `cameras: ${live.map((c) => c.name).join(', ')} (models loading in the background)`);
    else log('warn', 'vision', 'no cameras; vision stays offline until one is plugged in');
  }

  beginFrame(now: number): void {
    this.housekeeping(now);
  }

  names(kind: InputKind): string[] {
    return kind === 'camera' ? this.cams.filter((c) => c.dev.connected).map((c) => c.name) : [];
  }

  scoped(scope: Scope, params: ParamReader): VisionAPI {
    return {
      cameras: () => this.names('camera'),
      video: (src) => this.video(resolveSource(src, params)),
      mirrored: (src) => this.isMirrored(resolveSource(src, params)),
      track: (src, opts) => this.track(src, opts, scope, params),
    };
  }

  /* ------------------------------------------------------------ UI-facing */

  cameras(): CameraInfo[] {
    return this.cams.map((c) => {
      const tasks: string[] = [];
      const delegates = new Set<string>();
      for (const [kind, t] of Object.entries(c.tasks)) {
        if (!t) continue;
        tasks.push(`${kind}: ${t.state === 'ready' ? t.delegate : t.state}`);
        if (t.state === 'ready' && t.delegate) delegates.add(t.delegate);
      }
      return {
        name: c.name,
        label: c.label,
        connected: c.dev.connected,
        width: c.dev.width,
        height: c.dev.height,
        fps: c.videoFps,
        mirrored: c.mirrored,
        cvFps: c.subs ? c.cvFps : 0,
        cvLatencyMs: c.latencyMs,
        cvWorkerMs: c.workerMs,
        degrade: c.degrade,
        activeTasks: activeTasks(c.config),
        tasks,
        delegate: [...delegates].join('+') || '—',
        subscribers: c.subs,
        error: c.error ?? c.dev.error,
      };
    });
  }

  /** The camera's video element (null while it's offline). */
  video(name: string): HTMLVideoElement | null {
    const c = this.resolve(name);
    return c?.dev.connected ? c.dev.video : null;
  }

  isMirrored(name: string): boolean {
    return this.resolve(name)?.mirrored ?? false;
  }

  setMirrored(name: string, on: boolean): void {
    const c = this.resolve(name);
    if (!c || c.mirrored === on) return;
    c.mirrored = on;
    save(`vision:mirror:${c.label}`, on);
    // Landmark x flips; don't let that read as a burst of speed.
    c.tracker.reset();
    c.handTracker.reset();
    this.reconfigure();
    this.onChange();
  }

  /** Live zone states on a camera from any subscriber (for the zone editor). */
  zoneStates(name: string): Readonly<Record<string, ZoneState>> {
    const c = this.resolve(name);
    if (!c?.dev.connected || !c.zones.size) return NO_ZONES;
    if (c.zones.size === 1) return c.zones.values().next().value?.states ?? NO_ZONES;
    const out: Record<string, ZoneState> = {};
    for (const r of c.zones.values()) for (const k in r.states) out[k] ??= r.states[k];
    return out;
  }

  /* ---------------------------------------------------------------- handles */

  private track(src: string | { param: string }, opts: TrackOpts, scope: Scope, params: ParamReader): VisionHandle {
    const po = opts.pose, ho = opts.hands;
    const sub: Sub = {
      id: this.nextSubId++,
      name: resolveSource(src, params),
      pose: po
        ? {
            model: typeof po === 'object' && po.model === 'full' ? 'full' : 'lite',
            maxPeople: clampInt(typeof po === 'object' ? po.maxPeople : undefined, 3, 1, 10),
          }
        : null,
      hands: ho ? { maxHands: clampInt(typeof ho === 'object' ? ho.maxHands : undefined, 4, 1, 8) } : null,
      mask: !!opts.mask,
      zones: [],
      cam: null,
    };
    const zo = opts.zones;
    if (Array.isArray(zo)) {
      sub.zones = asZones(zo);
    } else if (zo) {
      sub.zones = asZones(params.get(zo.param));
      scope.add(params.on(zo.param, (v) => {
        sub.zones = asZones(v);
        this.reconfigure();
      }));
    }
    if (typeof src !== 'string') {
      scope.add(params.on(src.param, (v) => {
        sub.name = String(v ?? '');
        this.reconfigure();
      }));
    }
    this.subs.add(sub);
    scope.add(() => {
      this.subs.delete(sub);
      this.reconfigure();
      sub.cam = null; // a handle kept past unmount reads as disconnected
    });
    this.reconfigure();

    const live = (): Cam | null => (sub.cam?.dev.connected ? sub.cam : null);
    return {
      get connected() { return live() !== null; },
      get fps() { return live()?.cvFps ?? 0; },
      get latencyMs() { return live()?.latencyMs ?? 0; },
      get updatedAt() { return live()?.updatedAt ?? 0; },
      get people(): readonly Person[] {
        const c = live();
        if (!c || !sub.pose) return NONE;
        const p = c.tracker.people;
        return p.length > sub.pose.maxPeople ? p.slice(0, sub.pose.maxPeople) : p;
      },
      get hands(): readonly Hand[] {
        const c = live();
        if (!c || !sub.hands) return NONE;
        const h = c.handTracker.hands;
        return h.length > sub.hands.maxHands ? h.slice(0, sub.hands.maxHands) : h;
      },
      get mask() {
        const c = live();
        return c && sub.mask ? c.mask : null;
      },
      get zones() { return live()?.zones.get(sub.id)?.states ?? NO_ZONES; },
      get activity() { return live()?.activity ?? 0; },
    };
  }

  private resolve(name: string): Cam | null {
    const connected = this.cams.filter((c) => c.dev.connected);
    if (!name) return connected.find((c) => SHORT_NAMES.webcam.test(c.label)) ?? connected[0] ?? null;
    return findByName(name, connected) ?? findByName(name, this.cams) ?? null;
  }

  /** Re-resolve every subscriber and push each camera's merged task set to its worker. */
  private reconfigure(): void {
    const agg = new Map<Cam, { cfg: CvConfig; subs: number }>();
    for (const s of this.subs) {
      const c = (s.cam = this.resolve(s.name));
      if (!c) continue;
      let a = agg.get(c);
      if (!a) agg.set(c, (a = { cfg: { pose: null, hands: null, mask: false, zones: [] }, subs: 0 }));
      a.subs++;
      const cfg = a.cfg;
      if (s.pose) {
        cfg.pose = {
          model: cfg.pose?.model === 'full' || s.pose.model === 'full' ? 'full' : 'lite',
          numPoses: Math.max(cfg.pose?.numPoses ?? 0, s.pose.maxPeople),
        };
      }
      if (s.hands) cfg.hands = { numHands: Math.max(cfg.hands?.numHands ?? 0, s.hands.maxHands) };
      if (s.mask) cfg.mask = true;
      // Zones are drawn in display space; the worker sees raw frames.
      if (s.zones.length) cfg.zones.push({ id: s.id, zones: c.mirrored ? flipZones(s.zones) : s.zones });
    }
    for (const c of this.cams) {
      const a = agg.get(c);
      c.subs = a?.subs ?? 0;
      this.configure(c, a?.cfg ?? EMPTY_CONFIG);
      for (const id of c.zones.keys()) if (!c.config.zones.some((z) => z.id === id)) c.zones.delete(id);
    }
  }

  private configure(c: Cam, cfg: CvConfig): void {
    c.config = cfg;
    const key = JSON.stringify(cfg);
    if (key === c.configKey || !c.worker) return;
    c.configKey = key;
    this.post(c, { type: 'config', config: cfg });
  }

  /* ---------------------------------------------------------------- cameras */

  private devicesChanged(): void {
    for (const dev of this.registry.cameras) {
      let c = this.cams.find((x) => x.dev === dev);
      if (!c) {
        c = this.createCam(dev);
        this.cams.push(c);
      }
      if (dev.connected && dev.stream !== c.stream) {
        c.stream = dev.stream;
        c.error = null;
        this.armFrames(c);
        if (!c.worker && this.status !== 'idle') this.spawn(c);
      } else if (!dev.connected && c.stream) {
        c.stream = null;
        this.clearResults(c);
      }
    }
    if (this.status === 'running' || this.status === 'offline') {
      this.status = this.cams.some((c) => c.dev.connected) ? 'running' : 'offline';
    }
    this.reconfigure();
    this.onChange();
  }

  private createCam(dev: Camera): Cam {
    const short = shortNameFor(dev.label);
    return {
      label: dev.label,
      dev,
      name: short && !this.cams.some((c) => c.name === short) ? short : dev.label,
      mirrored: load<boolean>(`vision:mirror:${dev.label}`, false),
      stream: null,
      worker: null,
      restartAt: -Infinity,
      busy: false,
      busySince: 0,
      captureT: 0,
      seq: 0,
      config: EMPTY_CONFIG,
      configKey: '',
      subs: 0,
      rvfc: 0,
      rvfcAt: 0,
      lastPump: 0,
      statT0: performance.now(),
      statFrames: 0,
      statVideo: 0,
      statQuality: 0,
      videoFps: 0,
      cvFps: 0,
      latencyMs: 0,
      workerMs: 0,
      degrade: 0,
      tasks: {},
      error: null,
      tracker: new PersonTracker(),
      handTracker: new HandTracker(),
      mask: null,
      maskAt: 0,
      oldMasks: [],
      zones: new Map(),
      activity: 0,
      updatedAt: 0,
    };
  }

  private clearResults(c: Cam): void {
    c.tracker.reset();
    c.handTracker.reset();
    this.setMask(c, null, 0);
    c.zones.clear();
    c.activity = 0;
  }

  /* ------------------------------------------------------------- frame pump */

  private armFrames(c: Cam): void {
    const v = c.dev.video;
    if (c.rvfc) v.cancelVideoFrameCallback(c.rvfc);
    const cb = (_now: number, meta: VideoFrameCallbackMetadata): void => {
      c.rvfc = v.requestVideoFrameCallback(cb);
      c.rvfcAt = performance.now();
      c.statVideo++;
      this.pump(c, meta.captureTime);
    };
    c.rvfc = v.requestVideoFrameCallback(cb);
  }

  private pump(c: Cam, captureTime?: number): void {
    if (c.busy || !c.subs || !c.worker || !c.dev.connected) return;
    const v = c.dev.video;
    if (v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !v.videoWidth) return;
    const now = performance.now();
    c.busy = true;
    c.busySince = c.lastPump = now;
    c.captureT = captureTime !== undefined && captureTime <= now && now - captureTime < 1000 ? captureTime : now;
    const seq = ++c.seq;
    const worker = c.worker;
    createImageBitmap(v, { resizeWidth: FRAME_W, resizeHeight: FRAME_H }).then(
      (bitmap) => {
        if (c.worker !== worker || c.seq !== seq) { bitmap.close(); return; }
        this.post(c, { type: 'frame', seq, bitmap }, [bitmap]);
      },
      (e: unknown) => {
        if (c.seq === seq) c.busy = false;
        this.cvError(c, `could not grab a frame: ${errText(e)}`);
      },
    );
  }

  private housekeeping(now: number): void {
    for (const c of this.cams) {
      if (c.subs && now - c.rvfcAt > RVFC_SILENT_MS && now - c.lastPump >= MIN_PUMP_MS) this.pump(c);
      if (c.busy && now - c.busySince > WATCHDOG_MS) this.restart(c, `stalled for ${WATCHDOG_MS / 1000} s`);
      c.tracker.expire(now);
      c.handTracker.expire(now);
      if (c.mask && now - c.maskAt > MASK_STALE_MS) this.setMask(c, null, now);
      if (now - c.statT0 >= 1000) {
        const secs = (now - c.statT0) / 1000;
        let frames = c.statVideo;
        const q = c.dev.video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        if (!frames && c.dev.connected) frames = Math.max(0, q - c.statQuality);
        c.statQuality = q;
        c.videoFps = c.dev.connected ? frames / secs : 0;
        c.cvFps = c.statFrames / secs;
        c.statVideo = c.statFrames = 0;
        c.statT0 = now;
      }
    }
  }

  /* ---------------------------------------------------------------- workers */

  private spawn(c: Cam): void {
    let w: Worker;
    try {
      // Options must stay a static literal: Vite parses them.
      w = new Worker(new URL('./cv.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      this.cvError(c, `could not start the CV worker: ${errText(e)}`);
      return;
    }
    c.worker = w;
    c.busy = false;
    c.seq++;
    c.configKey = '';
    c.tasks = {};
    w.onmessage = (ev: MessageEvent<FromWorker>) => {
      if (c.worker !== w) return;
      try { this.onWorker(c, ev.data); } catch (e) { log('error', 'vision', `${c.name}: bad worker message`, e); }
    };
    w.onerror = (ev) => {
      ev.preventDefault();
      this.cvError(c, `CV worker error: ${ev.message || 'failed to load'}`);
      this.onChange();
    };
    w.onmessageerror = () => this.cvError(c, 'CV worker sent an unreadable message');
    this.post(c, { type: 'init', warm: WARM });
    this.configure(c, c.config);
  }

  private restart(c: Cam, why: string): void {
    const now = performance.now();
    if (now - c.restartAt < RESTART_MIN_MS) return;
    c.restartAt = now;
    log('warn', 'vision', `${c.name}: CV worker ${why}; restarting it`);
    try { c.worker?.terminate(); } catch { /* already gone */ }
    c.worker = null;
    this.spawn(c);
    this.onChange();
  }

  private post(c: Cam, msg: ToWorker, transfer: Transferable[] = []): void {
    try {
      c.worker?.postMessage(msg, transfer);
    } catch (e) {
      this.cvError(c, `could not reach the CV worker: ${errText(e)}`);
      if (msg.type === 'frame') {
        msg.bitmap.close();
        c.busy = false;
      }
    }
  }

  private cvError(c: Cam, msg: string): void {
    if (c.error !== msg) log('error', 'vision', `${c.name}: ${msg}`);
    c.error = msg;
  }

  private onWorker(c: Cam, m: FromWorker): void {
    switch (m.type) {
      case 'result':
        this.onResult(c, m);
        break;
      case 'status':
        c.tasks = m.tasks;
        this.onChange();
        break;
      case 'log':
        log(m.level, 'vision', `${c.name}: ${m.msg}`);
        if (m.level === 'error') c.error = m.msg;
        break;
    }
  }

  private onResult(c: Cam, m: CvResult): void {
    if (m.seq !== c.seq) {
      m.mask?.bitmap.close();
      return;
    }
    const now = performance.now();
    c.busy = false;
    const lat = now - c.captureT;
    c.latencyMs = c.latencyMs ? c.latencyMs * 0.9 + lat * 0.1 : lat;
    c.workerMs = c.workerMs ? c.workerMs * 0.9 + m.workerMs * 0.1 : m.workerMs;
    c.degrade = m.degrade;
    c.statFrames++;
    if (m.pose) c.tracker.update(m.pose.data, m.pose.n, now, c.mirrored);
    if (m.hands) c.handTracker.update(m.hands, now, c.mirrored);
    if (m.mask) this.setMask(c, { width: m.mask.width, height: m.mask.height, bitmap: m.mask.bitmap, data: m.mask.data }, now);
    for (const z of m.zones) this.applyZones(c, z);
    c.activity = m.activity;
    c.updatedAt = now;
  }

  private setMask(c: Cam, mask: Mask | null, now: number): void {
    // An app may still draw the previous mask this frame; close bitmaps two results later.
    if (c.mask) {
      c.oldMasks.push(c.mask.bitmap);
      while (c.oldMasks.length > 2) c.oldMasks.shift()?.close();
    }
    c.mask = mask;
    c.maskAt = now;
  }

  private applyZones(c: Cam, z: ZoneSetResult): void {
    if (!c.config.zones.some((x) => x.id === z.id)) return; // subscriber already left
    let rec = c.zones.get(z.id);
    if (!rec || !sameNames(rec.names, z.names)) {
      const states: Record<string, MutableZoneState> = {};
      for (const n of z.names) states[n] = { motion: 0, active: false, since: 0 };
      rec = { names: z.names, states };
      c.zones.set(z.id, rec);
    }
    for (let i = 0; i < z.names.length; i++) {
      const s = rec.states[z.names[i]];
      s.motion = z.motion[i];
      s.active = z.active[i] === 1;
      s.since = z.since[i] - performance.timeOrigin;
    }
  }
}
