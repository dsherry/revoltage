import { isHidden } from '../devices';
import { log } from '../log';

/** One camera, addressed by its label (deviceIds change when site data is cleared). */
export interface Camera {
  readonly label: string;
  /** Stable element: replugging swaps its srcObject, so references held by apps stay valid. */
  readonly video: HTMLVideoElement;
  deviceId: string | null;
  stream: MediaStream | null;
  connected: boolean;
  /** From track.getSettings(). */
  width: number;
  height: number;
  frameRate: number;
  error: string | null;
  failures: number;
}

const OPEN_TIMEOUT_MS = 8000;
const RETRY_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

/** getUserMedia with a timeout; a stream that arrives after giving up is stopped. */
async function openStream(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const p = navigator.mediaDevices.getUserMedia(constraints);
  try {
    return await withTimeout(p, OPEN_TIMEOUT_MS, 'camera did not open in time');
  } catch (e) {
    p.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
    throw e;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** Opens every (non-virtual) camera and keeps it bound across unplug/replug. */
export class CameraRegistry {
  readonly cameras: Camera[] = [];
  permission: 'unknown' | 'granted' | 'denied' | 'unsupported' = 'unknown';
  onChange: () => void = () => {};
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer = 0;

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.permission = 'unsupported';
      log('error', 'vision', 'camera API unavailable (needs a secure context); vision is offline');
      return;
    }
    await this.unlock();
    navigator.mediaDevices.addEventListener('devicechange', () => void this.refresh());
    await this.refresh();
  }

  /** Re-enumerate and (re)bind; concurrent calls coalesce. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try { await this.sync(); } catch (e) { log('error', 'vision', 'camera refresh failed', e); }
      } while (this.again);
      this.running = null;
    })();
    return this.running;
  }

  /** One permission prompt unlocks device labels. */
  private async unlock(): Promise<void> {
    try {
      const s = await openStream({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      this.permission = 'granted';
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      if (denied) this.permission = 'denied';
      log('error', 'vision', denied ? 'camera permission denied; vision is offline' : 'no camera available yet', e);
    }
  }

  private async sync(): Promise<void> {
    let all = await navigator.mediaDevices.enumerateDevices();
    const hasUnlabelled = all.some((d) => d.kind === 'videoinput' && !d.label);
    if (hasUnlabelled && this.permission === 'unknown') {
      // A camera appeared after a failed unlock (e.g. none was plugged in at Start).
      await this.unlock();
      all = await navigator.mediaDevices.enumerateDevices();
    }
    const seen = new Set<string>();
    const devices = all.filter((d) => {
      if (d.kind !== 'videoinput' || !d.deviceId || d.deviceId === 'default' || !d.label || isHidden(d.label)) return false;
      if (seen.has(d.label)) return false; // identical models can't be told apart by label; use the first
      seen.add(d.label);
      return true;
    });

    for (const cam of this.cameras) {
      if (cam.connected && !seen.has(cam.label)) {
        log('warn', 'vision', `${cam.label} disconnected`);
        this.unbind(cam);
      }
    }
    let failed = false;
    for (const d of devices) {
      let cam = this.cameras.find((c) => c.label === d.label);
      if (!cam) {
        cam = this.create(d.label);
        this.cameras.push(cam);
      }
      const live = cam.stream?.getVideoTracks().some((t) => t.readyState === 'live');
      if (live && cam.deviceId === d.deviceId) continue;
      if (!(await this.bind(cam, d.deviceId))) failed = true;
    }
    this.onChange();
    if (failed) this.scheduleRetry();
  }

  private create(label: string): Camera {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    return { label, video, deviceId: null, stream: null, connected: false, width: 0, height: 0, frameRate: 0, error: null, failures: 0 };
  }

  private async bind(cam: Camera, deviceId: string): Promise<boolean> {
    this.unbind(cam);
    try {
      const stream = await openStream({
        video: { deviceId: { exact: deviceId }, width: 1280, height: 720, frameRate: { ideal: 30 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no video track');
      const s = track.getSettings();
      cam.stream = stream;
      cam.deviceId = deviceId;
      cam.width = s.width ?? 0;
      cam.height = s.height ?? 0;
      cam.frameRate = s.frameRate ?? 0;
      cam.error = null;
      cam.failures = 0;
      cam.connected = true;
      track.addEventListener('ended', () => {
        if (cam.stream !== stream) return;
        log('warn', 'vision', `${cam.label} stopped`);
        this.unbind(cam);
        this.onChange();
        void this.refresh();
      });
      cam.video.srcObject = stream;
      await withTimeout(cam.video.play(), 3000, 'video did not start playing')
        .catch((e: unknown) => log('warn', 'vision', `${cam.label}: ${errText(e)}`));
      log('info', 'vision', `${cam.label}: ${cam.width}×${cam.height} @ ${cam.frameRate.toFixed(0)} fps`);
      return true;
    } catch (e) {
      cam.failures++;
      cam.error = errText(e);
      if (cam.failures === 1 || cam.failures % 20 === 0) log('error', 'vision', `could not open ${cam.label}`, e);
      return false;
    }
  }

  private unbind(cam: Camera): void {
    cam.stream?.getTracks().forEach((t) => t.stop());
    cam.stream = null;
    cam.deviceId = null;
    cam.connected = false;
    cam.video.srcObject = null;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      void this.refresh();
    }, RETRY_MS);
  }
}
