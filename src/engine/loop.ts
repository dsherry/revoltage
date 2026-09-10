import { log } from './log';

interface LoopHost {
  frame(now: number, dt: number): void;
  /** The window whose requestAnimationFrame should drive the loop. */
  driver(): Window;
}

/** With no animation frame for this long, the worker clock drives frames. */
const RAF_SILENT_MS = 100;
/** With no animation frame for this long, restart the rAF chain on the current driver. */
const RAF_RESTART_MS = 250;

/**
 * Frame loop driven by the output window's rAF (projector refresh, not
 * throttled when the control window is covered), else the control window's.
 * When no window gets animation frames (both covered, in another Space, or
 * behind a screen-sharing app), a worker clock keeps frames coming at 60 Hz so
 * music, MIDI and vision don't stall. A watchdog moves the rAF chain to the
 * current driver when it stops delivering.
 */
export class Loop {
  private token = 0;
  private last = 0;
  private rafAt = 0;
  private kickAt = 0;
  private rafWin: Window | null = null;
  private rafId = 0;

  constructor(private host: LoopHost) {}

  start(): void {
    this.last = this.rafAt = performance.now();
    this.kick();
    // Main-thread timers slow to 1 Hz in hidden pages; the worker clock below also runs the watchdog.
    window.setInterval(() => this.watchdog(performance.now()), RAF_RESTART_MS);
    try {
      // Options must stay a static literal: Vite parses them.
      const clock = new Worker(new URL('./tick.worker.ts', import.meta.url), { type: 'module' });
      clock.onmessage = () => {
        const now = performance.now();
        if (now - this.rafAt > RAF_SILENT_MS) this.run();
        this.watchdog(now);
      };
    } catch (e) {
      log('warn', 'engine', 'backup frame clock unavailable: frames stop while no window is visible', e);
    }
  }

  private watchdog(now: number): void {
    if (now - this.rafAt > RAF_RESTART_MS && now - this.kickAt > RAF_RESTART_MS) this.kick();
  }

  private kick(): void {
    this.kickAt = performance.now();
    // Drop the pending request, so hidden windows don't pile up callbacks.
    try { this.rafWin?.cancelAnimationFrame(this.rafId); } catch { /* window gone */ }
    this.schedule(++this.token);
  }

  private schedule(token: number): void {
    const win = this.host.driver();
    this.rafWin = win;
    this.rafId = win.requestAnimationFrame(() => this.tick(token));
  }

  private tick(token: number): void {
    if (token !== this.token) return;
    this.rafAt = performance.now();
    this.run();
    this.schedule(token);
  }

  private run(): void {
    // rAF timestamps from different windows use different time origins; use our own clock.
    const now = performance.now();
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), 1 / 15);
    this.last = now;
    try {
      this.host.frame(now, dt);
    } catch (e) {
      log('error', 'engine', e);
    }
  }
}
