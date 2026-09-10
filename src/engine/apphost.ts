import type { AppContext, AppDef, AppInstance, ClockSnapshot, Frame, MidiEvent, ParamSchema, SurfaceKind } from '@sdk';
import { createSurface, type SurfaceHandle } from './surfaces';
import { ParamStore } from './params/store';
import { Scope } from './scope';
import { log } from './log';
import type { Engine } from './engine';

export type HostStatus = 'idle' | 'loading' | 'running' | 'error' | 'suspended';

interface Mounted {
  def: AppDef;
  store: ParamStore;
  scope: Scope;
  surface: SurfaceHandle;
  instance: AppInstance | null;
  frame: { t: number; dt: number; frame: number; now: number; clock: ClockSnapshot; midi: readonly MidiEvent[]; fired(k: string): boolean };
  t0: number;
  errors: number;
}

const MAX_CONSECUTIVE_ERRORS = 10;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Mounts one app at a time (hard cut), isolates its errors, and tears it down completely. */
export class AppHost {
  current: Mounted | null = null;
  status: HostStatus = 'idle';
  /** Increments on every mount (the settings page rebuilds on it). */
  mountCount = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private engine: Engine) {}

  get canvas(): HTMLCanvasElement | null {
    return this.current?.surface.canvas ?? null;
  }

  /** Switches are serialized so rapid presses can't interleave mounts. */
  load(def: AppDef): Promise<void> {
    this.queue = this.queue.then(() => this.swap(def)).catch((e) => log('error', 'host', e));
    return this.queue;
  }

  restart(): void {
    const def = this.current?.def;
    if (def) void this.load(def);
  }

  frame(now: number, dt: number, clock: ClockSnapshot, midi: readonly MidiEvent[]): number {
    const m = this.current;
    if (!m?.instance || this.status !== 'running') return 0;
    const f = m.frame;
    f.t = (now - m.t0) / 1000;
    f.dt = dt;
    f.now = now;
    f.clock = clock;
    f.midi = midi;
    m.store.beginFrame();
    const t0 = performance.now();
    try {
      m.instance.frame(f as Frame);
      m.errors = 0;
    } catch (e) {
      m.errors++;
      if (m.errors <= 3) log('error', m.def.id, e);
      if (m.errors >= MAX_CONSECUTIVE_ERRORS) {
        this.status = 'suspended';
        log('error', m.def.id, `suspended after ${MAX_CONSECUTIVE_ERRORS} consecutive frame errors`);
        this.engine.emit();
      }
    }
    f.frame++;
    return performance.now() - t0;
  }

  resize(w: number, h: number): void {
    const m = this.current;
    if (!m) return;
    m.surface.resize(w, h);
    try { m.instance?.resize?.(w, h); } catch (e) { log('error', m.def.id, 'resize() threw', e); }
  }

  private async swap(def: AppDef): Promise<void> {
    await this.unmount();
    await this.mount(def);
  }

  private async unmount(): Promise<void> {
    const m = this.current;
    if (!m) return;
    const s = this.engine.services;
    await s.audio.fadeAppOut(80);
    this.current = null;
    this.status = 'idle';
    try { m.instance?.dispose?.(); } catch (e) { log('error', m.def.id, 'dispose() threw', e); }
    m.scope.dispose();
    m.store.flush();
    s.midi.allNotesOff();
    s.midi.appUnmounted();
    s.audio.resetAppBus();
    m.surface.dispose();
  }

  private async mount(def: AppDef): Promise<void> {
    this.status = 'loading';
    this.engine.emit();
    const { w, h } = this.engine.surfaceSize();
    const scope = new Scope();
    const store = new ParamStore(def.id, def.params);
    let surface: SurfaceHandle;
    try {
      surface = await createSurface(def.surface, this.engine.stageEl, w, h, () => {
        log('warn', def.id, 'GPU context lost; remounting');
        this.restart();
      });
    } catch (e) {
      log('error', def.id, e);
      this.status = 'error';
      this.engine.emit();
      return;
    }

    const s = this.engine.services;
    const ctx: AppContext<ParamSchema, SurfaceKind> = {
      surface: surface.surface,
      params: store.api,
      presets: store.presets,
      audio: s.audio.scoped(scope, store),
      midi: s.midi.scoped(scope, store),
      vision: s.vision.scoped(scope, store),
      sensors: s.sensors.scoped(scope, store),
      clock: s.clock.scoped(scope),
      own: (x) => {
        scope.add(typeof x === 'function' ? x : () => x.dispose());
        return x;
      },
      log: (...args) => log('info', def.id, ...args),
    };

    const m: Mounted = {
      def, store, scope, surface, instance: null, t0: performance.now(), errors: 0,
      frame: { t: 0, dt: 0, frame: 0, now: 0, clock: s.clock.snapshot(), midi: [], fired: store.fired },
    };
    this.current = m;
    this.mountCount++;
    try {
      m.instance = await withTimeout(Promise.resolve(def.setup(ctx)), 5000, 'setup() took longer than 5 s');
      m.t0 = performance.now();
      this.status = 'running';
      log('info', 'host', `loaded ${def.name}`);
    } catch (e) {
      log('error', def.id, 'setup failed:', e);
      this.status = 'error';
    }
    this.engine.emit();
  }
}
