// One module worker per camera: MediaPipe inference + zone motion, off the main thread.
import {
  FilesetResolver, GestureRecognizer, ImageSegmenter, PoseLandmarker,
  type GestureRecognizerResult, type MPMask, type PoseLandmarkerResult,
} from '@mediapipe/tasks-vision';
import type { Zone } from '@sdk';
import { ZoneDiffer, type ZoneSetResult } from './zones';

// Not exported by tasks-vision 1.0.1.
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/* ------------------------------------------------------------------ protocol */

export type TaskKind = 'pose-lite' | 'pose-full' | 'hands' | 'mask';
export type Delegate = 'GPU' | 'CPU';

/** What the main thread wants run on this camera (the union of all subscribers). */
export interface CvConfig {
  /** lowRate: every subscriber needs pose only now and then, so degrading thins pose instead of hands. */
  pose: { model: 'lite' | 'full'; numPoses: number; lowRate: boolean } | null;
  hands: { numHands: number } | null;
  mask: boolean;
  /** Zones are already in raw (unmirrored) frame coordinates. */
  zones: { id: number; zones: Zone[] }[];
}

export type ToWorker =
  | { type: 'init'; warm: TaskKind[] }
  | { type: 'config'; config: CvConfig }
  | { type: 'frame'; seq: number; bitmap: ImageBitmap };

/** n poses × 33 landmarks × (x, y, z, visibility). */
export interface PoseResult { n: number; data: Float32Array }
/** n hands × 21 landmarks × (x, y, z); labels are MediaPipe's (not yet swapped for the unmirrored input). */
export interface HandResult { n: number; data: Float32Array; handedness: string[]; gestures: string[]; scores: Float32Array }
/** Confidence 0–255 at MASK_W×MASK_H, plus the same as a white matte with confidence in alpha. */
export interface MaskResult { width: number; height: number; data: Uint8Array; bitmap: ImageBitmap }

export interface TaskStatus {
  state: 'loading' | 'ready' | 'failed';
  delegate: Delegate | null;
  error: string | null;
}

export interface CvResult {
  type: 'result';
  seq: number;
  workerMs: number;
  degrade: number;
  /** Present only for tasks that ran on this frame. */
  pose?: PoseResult;
  hands?: HandResult;
  mask?: MaskResult;
  zones: ZoneSetResult[];
  activity: number;
}

export type FromWorker =
  | CvResult
  | { type: 'status'; tasks: Partial<Record<TaskKind, TaskStatus>> }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string };

/* --------------------------------------------------------------------- setup */

interface WorkerScope {
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
  postMessage(msg: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'unhandledrejection', cb: (ev: PromiseRejectionEvent) => void): void;
  location: { origin: string };
  /** MediaPipe's loader calls this in module workers (importScripts throws there). */
  import?: (url: string) => Promise<void>;
  ModuleFactory?: unknown;
}
const ws = self as unknown as WorkerScope;

// Absolute URLs: Vite's dev server leaves them alone (no `?import` rewriting of public files).
const ORIGIN = ws.location.origin;
const WASM_BASE = `${ORIGIN}/mediapipe/wasm`;
const MODELS: Record<TaskKind, string> = {
  'pose-lite': `${ORIGIN}/models/pose_landmarker_lite.task`,
  'pose-full': `${ORIGIN}/models/pose_landmarker_full.task`,
  hands: `${ORIGIN}/models/gesture_recognizer.task`,
  mask: `${ORIGIN}/models/selfie_segmenter.tflite`,
};
const DEFAULT_POSES = 3;
const DEFAULT_HANDS = 4;
const MASK_W = 256;
const MASK_H = 144;
const SLOW_MS = 30;
const RETRY_FAILED_MS = 10_000;
const MAX_TASK_ERRORS = 5;

// MediaPipe clears self.ModuleFactory after every task it creates, and an ES module only
// evaluates once, so re-publish the factory from the (cached) module on every load.
ws.import = async (url: string): Promise<void> => {
  const mod = (await import(/* @vite-ignore */ url)) as { default?: unknown };
  if (typeof mod.default === 'function') ws.ModuleFactory = mod.default;
};

const post = (msg: FromWorker, transfer?: Transferable[]): void => ws.postMessage(msg, transfer ?? []);
const log = (level: 'info' | 'warn' | 'error', msg: string): void => post({ type: 'log', level, msg });
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const epochNow = (): number => performance.timeOrigin + performance.now();

ws.addEventListener('unhandledrejection', (ev) => log('error', `unhandled rejection: ${errMsg(ev.reason)}`));

let filesetP: Promise<WasmFileset> | null = null;
function fileset(): Promise<WasmFileset> {
  filesetP ??= FilesetResolver.forVisionTasks(WASM_BASE, true).catch((e: unknown) => {
    filesetP = null;
    throw e;
  });
  return filesetP;
}

/* --------------------------------------------------------------------- tasks */

interface Closable { close(): void }

interface Entry<T extends Closable> {
  readonly kind: TaskKind;
  readonly create: (fs: WasmFileset, delegate: Delegate, opt: number) => Promise<T>;
  readonly setOpt: ((r: T, opt: number) => Promise<void>) | null;
  runner: T | null;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  delegate: Delegate | null;
  /** numPoses / numHands the runner currently uses. */
  opt: number;
  want: number;
  busy: boolean;
  errors: number;
  error: string | null;
  failedAt: number;
}

function entry<T extends Closable>(
  kind: TaskKind,
  create: Entry<T>['create'],
  setOpt: Entry<T>['setOpt'],
  opt: number,
): Entry<T> {
  return { kind, create, setOpt, runner: null, state: 'idle', delegate: null, opt, want: opt, busy: false, errors: 0, error: null, failedAt: 0 };
}

const base = (kind: TaskKind, delegate: Delegate) => ({ modelAssetPath: MODELS[kind], delegate });

const poseLite = entry<PoseLandmarker>(
  'pose-lite',
  (fs, d, n) => PoseLandmarker.createFromOptions(fs, { baseOptions: base('pose-lite', d), runningMode: 'VIDEO', numPoses: n }),
  (r, n) => r.setOptions({ numPoses: n }),
  DEFAULT_POSES,
);
const poseFull = entry<PoseLandmarker>(
  'pose-full',
  (fs, d, n) => PoseLandmarker.createFromOptions(fs, { baseOptions: base('pose-full', d), runningMode: 'VIDEO', numPoses: n }),
  (r, n) => r.setOptions({ numPoses: n }),
  DEFAULT_POSES,
);
const hands = entry<GestureRecognizer>(
  'hands',
  (fs, d, n) => GestureRecognizer.createFromOptions(fs, { baseOptions: base('hands', d), runningMode: 'VIDEO', numHands: n }),
  (r, n) => r.setOptions({ numHands: n }),
  DEFAULT_HANDS,
);
const mask = entry<ImageSegmenter>(
  'mask',
  (fs, d) => ImageSegmenter.createFromOptions(fs, {
    baseOptions: base('mask', d), runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
  }),
  null,
  1,
);
const entries: readonly Pick<Entry<Closable>, 'kind' | 'state' | 'delegate' | 'error'>[] = [poseLite, poseFull, hands, mask];

function warm(k: TaskKind): void {
  if (k === 'hands') ensure(hands, DEFAULT_HANDS);
  else if (k === 'mask') ensure(mask, 1);
  else ensure(k === 'pose-full' ? poseFull : poseLite, DEFAULT_POSES);
}

// Task creation is serialized: MediaPipe's loader goes through the global ModuleFactory.
let chain: Promise<void> = Promise.resolve();
const enqueue = (fn: () => Promise<void>): void => {
  chain = chain.then(fn).catch((e: unknown) => log('error', errMsg(e)));
};

/** Frames within this window after a task loads are excluded from the degrade measure (shader warm-up). */
let warmUntil = 0;

function report(): void {
  const tasks: Partial<Record<TaskKind, TaskStatus>> = {};
  for (const e of entries) {
    if (e.state !== 'idle') tasks[e.kind] = { state: e.state, delegate: e.delegate, error: e.error };
  }
  post({ type: 'status', tasks });
}

function load<T extends Closable>(e: Entry<T>, cpuOnly = false): void {
  e.state = 'loading';
  report();
  enqueue(async () => {
    const t0 = performance.now();
    for (const d of cpuOnly ? (['CPU'] as const) : (['GPU', 'CPU'] as const)) {
      try {
        const want = e.want;
        e.runner = await e.create(await fileset(), d, want);
        e.opt = want;
        e.delegate = d;
        e.state = 'ready';
        e.errors = 0;
        e.error = null;
        warmUntil = performance.now() + 2000;
        log('info', `${e.kind} ready on ${d} in ${Math.round(performance.now() - t0)} ms`);
        report();
        return;
      } catch (err) {
        e.error = `${d}: ${errMsg(err)}`;
        log(d === 'GPU' ? 'warn' : 'error', `${e.kind} failed to initialise on ${d}: ${errMsg(err)}`);
      }
    }
    e.state = 'failed';
    e.failedAt = performance.now();
    report();
  });
}

/**
 * Make sure a task is loaded (lazily) and uses `want` poses/hands. Fewer poses is much
 * cheaper: with numPoses 1 MediaPipe skips the person detector while it's tracking.
 */
function ensure<T extends Closable>(e: Entry<T>, want: number): void {
  e.want = Math.max(1, want);
  if (e.state === 'idle') load(e);
  else if (e.state === 'failed' && performance.now() - e.failedAt > RETRY_FAILED_MS) load(e);
  else if (e.state === 'ready' && e.opt !== e.want && e.setOpt && !e.busy) {
    const setOpt = e.setOpt;
    e.busy = true;
    enqueue(async () => {
      const want = e.want;
      try {
        if (e.runner) await setOpt(e.runner, want);
        e.opt = want;
      } catch (err) {
        log('warn', `${e.kind}: could not change options: ${errMsg(err)}`);
        e.opt = e.want = want; // don't retry in a loop
      } finally {
        e.busy = false;
      }
      if (e.opt !== e.want) ensure(e, e.want); // changed again meanwhile
    });
  }
}

/** Run one task guarded: repeated failures drop GPU → CPU, then give up for a while. */
function run<T extends Closable>(e: Entry<T>, fn: (r: T) => void): void {
  if (e.state !== 'ready' || e.busy || !e.runner) return;
  try {
    fn(e.runner);
    e.errors = 0;
  } catch (err) {
    e.errors++;
    e.error = errMsg(err);
    if (e.errors <= 3) log('error', `${e.kind} failed on a frame: ${e.error}`);
    if (e.errors < MAX_TASK_ERRORS) return;
    try { e.runner.close(); } catch { /* already broken */ }
    e.runner = null;
    if (e.delegate === 'GPU') {
      log('warn', `${e.kind}: too many GPU errors; switching to CPU`);
      load(e, true);
    } else {
      e.state = 'failed';
      e.failedAt = performance.now();
      report();
    }
  }
}

/* -------------------------------------------------------------------- frames */

let config: CvConfig = { pose: null, hands: null, mask: false, zones: [] };
let differ: ZoneDiffer | null = null;
let differFailed = false;
let lastTs = 0;
let frameNo = 0;
let degrade = 0;
let degradeAt = 0;
let ema = 0;
let samples = 0;

const maskCanvas = new OffscreenCanvas(MASK_W, MASK_H);
const maskCtx = maskCanvas.getContext('2d');
const maskImage = new ImageData(MASK_W, MASK_H);
for (let i = 0; i < MASK_W * MASK_H; i++) {
  maskImage.data[i * 4] = maskImage.data[i * 4 + 1] = maskImage.data[i * 4 + 2] = 255;
}

function getDiffer(): ZoneDiffer | null {
  if (!differ && !differFailed) {
    try { differ = new ZoneDiffer(); } catch (e) { differFailed = true; log('error', `zone motion unavailable: ${errMsg(e)}`); }
  }
  return differ;
}

function applyConfig(c: CvConfig): void {
  config = c;
  if (c.pose) ensure(c.pose.model === 'full' ? poseFull : poseLite, c.pose.numPoses);
  if (c.hands) ensure(hands, c.hands.numHands);
  if (c.mask) ensure(mask, 1);
  const d = getDiffer();
  if (!d) return;
  const now = epochNow();
  d.retain(new Set(c.zones.map((z) => z.id)));
  for (const z of c.zones) d.setZones(z.id, z.zones, now);
}

function packPose(r: PoseLandmarkerResult): PoseResult {
  const n = r.landmarks.length;
  const data = new Float32Array(n * 33 * 4);
  let o = 0;
  for (const lms of r.landmarks) {
    for (let i = 0; i < 33; i++) {
      const p = lms[i];
      data[o++] = p?.x ?? 0;
      data[o++] = p?.y ?? 0;
      data[o++] = p?.z ?? 0;
      data[o++] = p?.visibility ?? 0;
    }
  }
  return { n, data };
}

function packHands(r: GestureRecognizerResult): HandResult {
  const n = r.landmarks.length;
  const data = new Float32Array(n * 21 * 3);
  const scores = new Float32Array(n);
  const handedness: string[] = [];
  const gestures: string[] = [];
  let o = 0;
  for (let h = 0; h < n; h++) {
    const lms = r.landmarks[h];
    for (let i = 0; i < 21; i++) {
      const p = lms[i];
      data[o++] = p?.x ?? 0;
      data[o++] = p?.y ?? 0;
      data[o++] = p?.z ?? 0;
    }
    handedness.push(r.handedness[h]?.[0]?.categoryName ?? 'Right');
    const g = r.gestures[h]?.[0];
    gestures.push(g?.categoryName || 'None');
    scores[h] = g?.score ?? 0;
  }
  return { n, data, handedness, gestures, scores };
}

function packMask(m: MPMask): MaskResult | undefined {
  const src = m.getAsFloat32Array();
  const sw = m.width, sh = m.height;
  if (!sw || !sh || src.length < sw * sh) return undefined;
  const data = new Uint8Array(MASK_W * MASK_H);
  const px = maskImage.data;
  for (let y = 0, i = 0; y < MASK_H; y++) {
    const row = Math.min(sh - 1, (((y + 0.5) * sh) / MASK_H) | 0) * sw;
    for (let x = 0; x < MASK_W; x++, i++) {
      const v = src[row + Math.min(sw - 1, (((x + 0.5) * sw) / MASK_W) | 0)];
      const c = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
      data[i] = c;
      px[i * 4 + 3] = c;
    }
  }
  if (!maskCtx) return undefined;
  maskCtx.putImageData(maskImage, 0, 0);
  return { width: MASK_W, height: MASK_H, data, bitmap: maskCanvas.transferToImageBitmap() };
}

function onFrame(seq: number, bitmap: ImageBitmap): void {
  const t0 = performance.now();
  const out: CvResult = { type: 'result', seq, workerMs: 0, degrade, zones: [], activity: 0 };
  const transfer: Transferable[] = [];
  try {
    // MediaPipe VIDEO mode needs strictly increasing timestamps (ms).
    const ts = (lastTs = Math.max(lastTs + 1, Math.round(t0)));
    frameNo++;
    const c = config;

    // Degrade level 1 thins hands, or pose instead when it's only needed now and then.
    const thinPose = degrade >= 1 && !!c.pose?.lowRate;
    if (c.pose && (!thinPose || frameNo % 3 === 0)) {
      const e = c.pose.model === 'full' && poseFull.state === 'ready' ? poseFull : poseLite;
      if (c.pose.model === 'full' && e === poseLite && poseLite.state === 'idle') ensure(poseLite, c.pose.numPoses);
      run(e, (r) => { out.pose = packPose(r.detectForVideo(bitmap, ts)); });
    }
    if (c.hands && (degrade < 1 || thinPose || frameNo % 2 === 0)) {
      run(hands, (r) => { out.hands = packHands(r.recognizeForVideo(bitmap, ts)); });
    }
    if (c.mask && (degrade < 2 || frameNo % 3 === 0)) {
      run(mask, (r) => {
        r.segmentForVideo(bitmap, ts, (res) => {
          const masks = res.confidenceMasks;
          // One channel = person; two (background, person) = the last one.
          const m = masks?.length ? masks[masks.length - 1] : undefined;
          if (m) out.mask = packMask(m);
        });
      });
    }
    const d = getDiffer();
    if (d) {
      d.process(bitmap, epochNow());
      out.zones = d.results();
      out.activity = d.activity;
    }
  } catch (e) {
    log('error', `frame failed: ${errMsg(e)}`);
  } finally {
    bitmap.close();
  }

  const ms = performance.now() - t0;
  if (t0 <= warmUntil) {
    // Warm-up frames (shader compiles) would poison the average; measure afresh afterwards.
    ema = 0;
    samples = 0;
  } else {
    ema = samples++ ? ema * 0.9 + ms * 0.1 : ms;
    if (samples < 20) {
      // not enough evidence yet
    } else if (
      ema > SLOW_MS && t0 - degradeAt > 1000 &&
      // Only step when the step sheds work that's actually running.
      ((degrade === 0 && (config.hands || config.mask || config.pose?.lowRate)) || (degrade === 1 && config.mask))
    ) {
      degrade++;
      degradeAt = t0;
      const shed = degrade === 1 ? (config.pose?.lowRate ? 'pose now every 3rd frame' : 'hands now every 2nd frame') : 'mask now every 3rd frame';
      log('warn', `CV takes ${ema.toFixed(0)} ms/frame: ${shed}`);
    } else if (ema < SLOW_MS / 2 && degrade > 0 && t0 - degradeAt > 5000) {
      degrade--;
      degradeAt = t0;
      log('info', `CV back under budget (${ema.toFixed(0)} ms/frame); degrade level ${degrade}`);
    }
  }
  out.workerMs = ms;
  out.degrade = degrade;
  if (out.pose) transfer.push(out.pose.data.buffer);
  if (out.hands) transfer.push(out.hands.data.buffer, out.hands.scores.buffer);
  if (out.mask) transfer.push(out.mask.data.buffer, out.mask.bitmap);
  post(out, transfer);
}

ws.onmessage = (ev) => {
  const m = ev.data;
  try {
    switch (m.type) {
      case 'init':
        for (const k of m.warm) warm(k);
        break;
      case 'config':
        applyConfig(m.config);
        break;
      case 'frame':
        onFrame(m.seq, m.bitmap);
        break;
    }
  } catch (e) {
    log('error', `${m.type} failed: ${errMsg(e)}`);
    // The main thread waits for a reply to every frame.
    if (m.type === 'frame') post({ type: 'result', seq: m.seq, workerMs: 0, degrade, zones: [], activity: 0 });
  }
};
