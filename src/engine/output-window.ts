import { log } from './log';

/**
 * The projector window. It only displays: each frame the engine copies the
 * stage canvas into it, so it can close or reload without affecting anything.
 */
export class OutputWindow {
  win: Window | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;

  constructor(private onChange: () => void) {}

  get isOpen(): boolean {
    return !!this.win && !this.win.closed && !!this.g;
  }

  /** Visible windows get rAF at their display's refresh; hidden ones get none. */
  get visible(): boolean {
    return this.isOpen && this.win!.document.visibilityState === 'visible';
  }

  size(): { w: number; h: number } | null {
    return this.isOpen && this.canvas ? { w: this.canvas.width, h: this.canvas.height } : null;
  }

  async open(): Promise<void> {
    if (this.win && !this.win.closed) { this.win.focus(); return; }
    let features = 'popup,width=1280,height=720';
    try {
      // Place it on the other screen when Window Management permission was already granted.
      const perm = await navigator.permissions.query({ name: 'window-management' as PermissionName });
      const w = window as unknown as { getScreenDetails?: () => Promise<ScreenDetailsLike> };
      if (perm.state === 'granted' && w.getScreenDetails) {
        const sd = await w.getScreenDetails();
        const other = sd.screens.find((s) => s !== sd.currentScreen);
        if (other) features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
      }
    } catch { /* default placement */ }
    if (!window.open('/output.html', 'revoltage-output', features)) {
      log('warn', 'output', 'popup blocked: allow popups for localhost:5173');
    }
  }

  /** Called by the output window's script once it has loaded (and again after a control reload). */
  attach(win: Window): void {
    if (this.win === win && this.g) return;
    this.win = win;
    this.canvas = win.document.getElementById('out') as HTMLCanvasElement | null;
    this.g = this.canvas?.getContext('2d', { alpha: false, desynchronized: true }) ?? null;
    win.addEventListener('resize', () => this.resize());
    win.addEventListener('pagehide', () => { if (this.win === win) this.detach(); });
    this.resize();
    log('info', 'output', 'output window attached');
  }

  requestFullscreen(): void {
    if (!this.win || this.win.closed) return;
    try {
      // Capability delegation lets the output window go fullscreen from this click.
      this.win.postMessage({ type: 'fullscreen' }, { targetOrigin: location.origin, delegate: 'fullscreen' } as WindowPostMessageOptions);
    } catch (e) {
      log('warn', 'output', 'fullscreen delegation failed; click inside the output window instead', e);
    }
    this.win.focus();
  }

  /** Copy the stage into the output. Returns the time taken in ms. */
  mirror(src: HTMLCanvasElement | null, black: boolean): number {
    if (!this.g || !this.canvas) return 0;
    if (!this.win || this.win.closed) { this.detach(); return 0; }
    const t = performance.now();
    if (black || !src) {
      this.g.fillStyle = '#000';
      this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    } else {
      this.g.drawImage(src, 0, 0, this.canvas.width, this.canvas.height);
    }
    return performance.now() - t;
  }

  private detach(): void {
    this.win = null;
    this.canvas = null;
    this.g = null;
    log('info', 'output', 'output window closed');
    this.onChange();
  }

  private resize(): void {
    const w = this.win, c = this.canvas;
    if (!w || !c) return;
    const dpr = w.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(w.innerWidth * dpr));
    c.height = Math.max(1, Math.round(w.innerHeight * dpr));
    this.onChange();
  }
}

interface ScreenLike { availLeft: number; availTop: number; availWidth: number; availHeight: number }
interface ScreenDetailsLike { screens: ScreenLike[]; currentScreen: ScreenLike }
