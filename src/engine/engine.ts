import type { AppDef, InputKind } from '@sdk';
import { registry } from './registry';
import { AppHost } from './apphost';
import { Loop } from './loop';
import { OutputWindow } from './output-window';
import { Stats } from './stats';
import { Emitter } from './scope';
import { load, save } from './persist';
import { log } from './log';
import { handleKey } from './keyboard';
import { createStubServices } from './stubs';
import type { Services } from './services';

const DEFAULT_OUTPUT = { w: 1920, h: 1080 };
const MAX_WIDTH = 2560;

/** The platform: owns devices, the app host, the frame loop and the output window. */
export class Engine {
  readonly events = new Emitter();
  /** Container for the active app's canvas; the Stage component displays it as the preview. */
  readonly stageEl = document.createElement('div');
  readonly output: OutputWindow;
  readonly host: AppHost;
  readonly loop: Loop;
  readonly stats = new Stats();
  readonly services: Services = createStubServices();
  readonly keyboard = { handle: (e: KeyboardEvent) => handleKey(e, this) };

  started = false;
  starting = false;
  blackout = false;
  panicked = false;
  renderScale = load<number>('renderScale', 1);
  setlist: (string | null)[];
  activeSlot = -1;
  private size = { ...DEFAULT_OUTPUT };

  constructor() {
    this.stageEl.style.cssText = 'position:relative;width:100%;height:50vh;background:#000;';
    this.output = new OutputWindow(() => this.onOutputChanged());
    this.host = new AppHost(this);
    this.loop = new Loop({
      frame: (now, dt) => this.frame(now, dt),
      driver: () => (this.output.visible ? this.output.win! : window),
    });
    const saved = load<(string | null)[]>('setlist', []);
    const ids = registry.list().map((d) => d.id);
    this.setlist = Array.from({ length: 8 }, (_, i) => {
      if (i >= saved.length) return ids[i] ?? null;
      const id = saved[i];
      return id && registry.get(id) ? id : null;
    });
    this.updateSize();
  }

  boot(): void {
    window.addEventListener('keydown', this.keyboard.handle);
  }

  /** From the Start click: unlock audio, open devices, start the loop, load the first slot. */
  async start(): Promise<void> {
    if (this.started || this.starting) return;
    this.starting = true;
    this.emit();
    for (const [name, svc] of Object.entries(this.services)) {
      try { await svc.start(); } catch (e) { log('error', name, 'failed to start:', e); }
    }
    this.started = true;
    this.starting = false;
    this.loop.start();
    log('info', 'engine', 'started');
    const first = this.setlist.findIndex(Boolean);
    if (first >= 0) await this.loadSlot(first);
    this.emit();
  }

  frame(now: number, dt: number): void {
    const t0 = performance.now();
    const s = this.services;
    const midi = s.midi.drain();
    s.audio.beginFrame?.(now, dt);
    s.sensors.beginFrame?.(now, dt);
    s.vision.beginFrame?.(now, dt);
    s.clock.beginFrame?.(now, dt);
    const appMs = this.host.frame(now, dt, s.clock.snapshot(), midi);
    s.midi.endFrame?.(now);
    const mirrorMs = this.output.mirror(this.host.canvas, this.blackout);
    this.stats.record(now, performance.now() - t0, appMs, mirrorMs);
  }

  async loadSlot(i: number): Promise<void> {
    const id = this.setlist[i];
    if (!id || !this.started) return;
    this.activeSlot = i;
    await this.loadApp(id);
  }

  async loadApp(id: string): Promise<void> {
    const def = registry.get(id);
    if (!def) { log('warn', 'engine', `no app "${id}"`); return; }
    if (!this.started) return;
    if (this.setlist[this.activeSlot] !== id) this.activeSlot = this.setlist.indexOf(id);
    await this.host.load(def);
    this.emit();
  }

  setSlot(i: number, id: string | null): void {
    this.setlist[i] = id;
    save('setlist', this.setlist);
    this.emit();
  }

  toggleBlackout(): void {
    this.blackout = !this.blackout;
    this.emit();
  }

  togglePanic(): void {
    this.panicked = !this.panicked;
    this.services.audio.setPanic(this.panicked);
    if (this.panicked) this.services.midi.allNotesOff();
    log('warn', 'engine', this.panicked ? 'PANIC: app audio muted, all notes off' : 'panic released');
    this.emit();
  }

  setRenderScale(scale: number): void {
    this.renderScale = scale;
    save('renderScale', scale);
    this.updateSize();
    this.emit();
  }

  hotSwap(def: AppDef): void {
    registry.replace(def);
    if (this.host.current?.def.id === def.id) {
      log('info', 'hmr', `reloaded ${def.name}`);
      void this.host.load(def);
    }
    this.emit();
  }

  deviceNames(kind: InputKind): string[] {
    return Object.values(this.services).flatMap((s) => s.names?.(kind) ?? []);
  }

  surfaceSize(): { w: number; h: number } {
    return this.size;
  }

  emit(): void {
    this.events.emit();
  }

  private onOutputChanged(): void {
    this.updateSize();
    this.emit();
  }

  /** Surface size = output window size (capped) × render scale. */
  private updateSize(): void {
    let { w, h } = this.output.size() ?? DEFAULT_OUTPUT;
    if (w > MAX_WIDTH) { h = (h * MAX_WIDTH) / w; w = MAX_WIDTH; }
    w = Math.max(64, Math.round(w * this.renderScale));
    h = Math.max(36, Math.round(h * this.renderScale));
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.host.resize(w, h);
  }
}

export const engine = new Engine();
