class Ring {
  private buf: Float64Array;
  private i = 0;
  private n = 0;

  constructor(size: number) {
    this.buf = new Float64Array(size);
  }

  push(v: number): void {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.buf.length;
    this.n = Math.min(this.n + 1, this.buf.length);
  }

  p95(): number {
    if (!this.n) return 0;
    const a = Array.from(this.buf.subarray(0, this.n)).sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
  }
}

export interface StatsSummary { fps: number; frameP95: number; appP95: number; mirrorP95: number }

export class Stats {
  private frame = new Ring(120);
  private app = new Ring(120);
  private mirror = new Ring(120);
  private ticks = 0;
  private windowStart = 0;
  private fps = 0;

  record(now: number, frameMs: number, appMs: number, mirrorMs: number): void {
    this.frame.push(frameMs);
    this.app.push(appMs);
    this.mirror.push(mirrorMs);
    this.ticks++;
    if (now - this.windowStart >= 500) {
      this.fps = (this.ticks * 1000) / (now - this.windowStart || 1);
      this.ticks = 0;
      this.windowStart = now;
    }
  }

  summary(): StatsSummary {
    return { fps: this.fps, frameP95: this.frame.p95(), appP95: this.app.p95(), mirrorP95: this.mirror.p95() };
  }
}
