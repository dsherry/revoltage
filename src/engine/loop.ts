import { log } from './log';

interface LoopHost {
  frame(now: number, dt: number): void;
  /** The window whose requestAnimationFrame should drive the loop. */
  driver(): Window;
}

/**
 * Frame loop driven by the output window's rAF (projector refresh, not
 * throttled when the control window is covered), else the control window's.
 * A watchdog restarts the chain if the driving window stops delivering frames.
 */
export class Loop {
  private token = 0;
  private last = 0;
  private lastTickAt = 0;

  constructor(private host: LoopHost) {}

  start(): void {
    this.last = this.lastTickAt = performance.now();
    this.kick();
    window.setInterval(() => {
      if (performance.now() - this.lastTickAt > 250) this.kick();
    }, 250);
  }

  private kick(): void {
    this.schedule(++this.token);
  }

  private schedule(token: number): void {
    this.host.driver().requestAnimationFrame(() => this.tick(token));
  }

  private tick(token: number): void {
    if (token !== this.token) return;
    // rAF timestamps from different windows use different time origins; use our own clock.
    const now = performance.now();
    const dt = Math.min(Math.max((now - this.last) / 1000, 0), 1 / 15);
    this.last = this.lastTickAt = now;
    try {
      this.host.frame(now, dt);
    } catch (e) {
      log('error', 'engine', e);
    }
    this.schedule(token);
  }
}
