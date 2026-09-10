import type { ApcButtonLed, ApcColor, ApcMini, Unsub } from '@sdk';
import type { Scope } from '../scope';
import { load, save } from '../persist';
import { log } from '../log';
import type { MidiHooks } from './midi';

// Akai APC mini mk1, community-documented (spec §7.6). It uses channel 1 for everything.
const TRACK0 = 64; // track buttons 1–8: bottom row, red LEDs
const SCENE0 = 82; // scene buttons 1–8: right column, green LEDs
const SHIFT = 98;
const FADER0 = 48; // faders 1–8 are CC 48–55
const MASTER = 56;
const FLUSH_MS = 33;
/** A second full LED resend after (re)connect, in case the first went out while the device was still enumerating. */
const RESEND_MS = 600;
const PICKUP_WINDOW = 0.03;
const FADERS_KEY = 'apc:faders';

const PAD_VELOCITY: Readonly<Record<string, number>> = { green: 1, red: 3, yellow: 5 };
const BUTTON_VELOCITY: Readonly<Record<string, number>> = { off: 0, on: 1, blink: 2 };
/** Every note with an LED: pads 0–63, track 64–71, scene 82–89. */
const LED_NOTES = Uint8Array.from({ length: 80 }, (_, i) => (i < 72 ? i : SCENE0 + i - 72));

const isTrack = (n: number): boolean => n >= TRACK0 && n < TRACK0 + 8;
const isScene = (n: number): boolean => n >= SCENE0 && n < SCENE0 + 8;
/** 0–7, or -1 when out of range. */
const index8 = (v: number): number => {
  const i = Math.floor(v);
  return i >= 0 && i < 8 ? i : -1;
};
const padVelocity = (color: ApcColor | null, blink: boolean): number => {
  const v = color ? PAD_VELOCITY[color] ?? 0 : 0;
  return v && blink ? v + 1 : v;
};

let lastErrorAt = -Infinity;
let suppressed = 0;

/** Log a MIDI-path error at most once a second: a listener that throws on every message would flood the log. */
export function midiError(msg: string, e: unknown): void {
  const now = performance.now();
  if (now - lastErrorAt < 1000) { suppressed++; return; }
  lastErrorAt = now;
  log('error', 'midi', suppressed ? `${msg} (${suppressed} similar errors suppressed)` : msg, e);
  suppressed = 0;
}

export type PadListener = (x: number, y: number, down: boolean) => void;
export type FaderListener = (index: number, value: number) => void;
export type ButtonListener = (index: number, down: boolean) => void;
type ApcEvent = 'pad' | 'fader' | 'track' | 'scene';

/** APC mini mk1: input decoding, the reserved global controls, and the two-layer LED frame buffer. */
export class ApcDriver {
  /** Faders 1–8. The mk1 can't report positions, so these start at the last-seen values. */
  readonly faders = new Float32Array(8);
  shift = false;
  inConnected = false;
  outConnected = false;
  readonly listeners = {
    pad: new Set<PadListener>(),
    fader: new Set<FaderListener>(),
    track: new Set<ButtonListener>(),
    scene: new Set<ButtonListener>(),
  };

  /** App LED layer: velocity by note. */
  private readonly app = new Uint8Array(128);
  /** Last velocity sent per note; -1 = unknown, so the next flush sends it. */
  private readonly sent = new Int16Array(128).fill(-1);
  /** Presses delivered to the app (for held() and releasing on unplug). */
  private readonly down = new Uint8Array(128);
  /** Presses consumed by a global control; their releases are consumed too. */
  private readonly taken = new Uint8Array(128);
  private lastFlush = -Infinity;
  private resendAt = 0;
  private picked = false;
  private lastMaster = -1;
  private lastSet = -1;
  private saveTimer = 0;

  constructor(
    private readonly hooks: MidiHooks,
    private readonly sendLed: (note: number, velocity: number) => boolean,
    private readonly changed: () => void,
  ) {
    const saved = load<unknown>(FADERS_KEY, null);
    if (Array.isArray(saved)) {
      for (let i = 0; i < 8; i++) {
        const v = Number(saved[i]);
        if (v >= 0 && v <= 1) this.faders[i] = v;
      }
    }
  }

  get connected(): boolean {
    return this.inConnected || this.outConnected;
  }

  /** Whether the master fader currently controls the master volume. */
  get pickedUp(): boolean {
    return this.picked;
  }

  /** Decode one channel message from the APC. Returns true if the platform consumed it. */
  handle(status: number, d1: number, d2: number): boolean {
    const kind = status & 0xf0;
    if (kind === 0xb0) return this.onCc(d1, d2 / 127);
    if (kind === 0x90 || kind === 0x80) return this.onNote(d1, kind === 0x90 && d2 > 0);
    return false;
  }

  held(x: number, y: number): boolean {
    const xi = index8(x), yi = index8(y);
    return xi >= 0 && yi >= 0 && this.down[yi * 8 + xi] === 1;
  }

  /* ---------------------------------------------------------- connection */

  inputUp(): void {
    this.inConnected = true;
    this.shift = false;
    this.taken.fill(0);
    this.down.fill(0);
    this.resetPickup();
  }

  /** Unplugged: release everything the app saw pressed, so nothing stays stuck. */
  inputLost(): void {
    this.inConnected = false;
    this.shift = false;
    this.taken.fill(0);
    this.resetPickup();
    for (let note = 0; note < 128; note++) {
      if (!this.down[note]) continue;
      this.down[note] = 0;
      this.emit(note, false);
    }
  }

  /** (Re)connected: its LEDs are in an unknown state, so resend everything (off included). */
  outputUp(now: number): void {
    this.outConnected = true;
    this.invalidate();
    this.resendAt = now + RESEND_MS;
  }

  outputLost(): void {
    this.outConnected = false;
    this.sent.fill(-1);
  }

  /** Forget what the hardware shows; the next flush resends every LED. */
  invalidate(): void {
    this.sent.fill(-1);
    this.lastFlush = -Infinity;
  }

  /* ---------------------------------------------------------------- LEDs */

  setPad(x: number, y: number, color: ApcColor | null, blink: boolean): void {
    const xi = index8(x), yi = index8(y);
    if (xi >= 0 && yi >= 0) this.app[yi * 8 + xi] = padVelocity(color, blink);
  }

  setTrack(i: number, state: ApcButtonLed): void {
    const k = index8(i);
    if (k >= 0) this.app[TRACK0 + k] = BUTTON_VELOCITY[state] ?? 0;
  }

  setScene(i: number, state: ApcButtonLed): void {
    const k = index8(i);
    if (k >= 0) this.app[SCENE0 + k] = BUTTON_VELOCITY[state] ?? 0;
  }

  fill(fn: (x: number, y: number) => ApcColor | null): void {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) this.app[y * 8 + x] = padVelocity(fn(x, y), false);
  }

  clear(): void {
    this.app.fill(0);
  }

  clearListeners(): void {
    for (const set of Object.values(this.listeners)) set.clear();
  }

  /** Send the LEDs that differ from what the hardware shows, at most every 33 ms. */
  flush(now: number): void {
    if (!this.outConnected || now - this.lastFlush < FLUSH_MS) return;
    this.lastFlush = now;
    if (this.resendAt && now >= this.resendAt) {
      this.resendAt = 0;
      this.sent.fill(-1);
    }
    // Platform overlay: while Shift is held the scene LEDs show the setlist.
    const setlist = this.shift ? this.setlist() : null;
    for (let i = 0; i < LED_NOTES.length; i++) {
      const note = LED_NOTES[i];
      let v = this.app[note];
      if (setlist && isScene(note)) {
        const slot = note - SCENE0;
        v = slot === setlist.active ? 2 : setlist.filled[slot] ? 1 : 0;
      }
      if (this.sent[note] === v) continue;
      if (!this.sendLed(note, v)) return; // port gone or send failed: the rest go next flush
      this.sent[note] = v;
    }
  }

  /* --------------------------------------------------------------- input */

  private onNote(note: number, down: boolean): boolean {
    if (note === SHIFT) {
      this.shift = down;
      return false;
    }
    // ◀ / ▶ (track buttons 3 and 4) always step through the setlist.
    if (note === TRACK0 + 2 || note === TRACK0 + 3) {
      if (down) {
        try { this.hooks.stepSlot(note === TRACK0 + 3 ? 1 : -1); } catch (e) { log('error', 'midi', 'APC setlist step failed', e); }
      }
      return true;
    }
    const button = isTrack(note) || isScene(note);
    if (down && this.shift && button) {
      this.taken[note] = 1;
      this.globalPress(note);
      return true;
    }
    if (!down && this.taken[note]) {
      this.taken[note] = 0;
      return true;
    }
    if (note < 64 || button) {
      this.down[note] = down ? 1 : 0;
      this.emit(note, down);
    }
    return false;
  }

  /** Shift + Scene i loads slot i; Shift + Track 1 / 8 toggle blackout / panic. Other Shift + Track presses do nothing. */
  private globalPress(note: number): void {
    try {
      if (isScene(note)) this.hooks.loadSlot(note - SCENE0);
      else if (note === TRACK0) this.hooks.toggleBlackout();
      else if (note === TRACK0 + 7) this.hooks.togglePanic();
    } catch (e) {
      log('error', 'midi', 'APC global control failed', e);
    }
  }

  private onCc(cc: number, v: number): boolean {
    if (cc === MASTER) {
      this.master(v);
      return true;
    }
    const i = cc - FADER0;
    if (i < 0 || i >= 8) return false;
    this.faders[i] = v;
    this.saveFaders();
    for (const cb of this.listeners.fader) {
      try { cb(i, v); } catch (e) { midiError('apc fader listener threw', e); }
    }
    return false;
  }

  /** Master volume with pickup: the fader takes over only once it meets (or crosses) the current volume. */
  private master(v: number): void {
    try {
      const cur = this.hooks.getMasterVolume();
      // Changed elsewhere (UI) since we last set it: pick up again rather than jump.
      if (this.picked && Math.abs(cur - this.lastSet) > 0.01) this.setPicked(false);
      if (!this.picked) {
        const last = this.lastMaster;
        const crossed = last >= 0 && (last - cur) * (v - cur) <= 0;
        if (crossed || Math.abs(v - cur) <= PICKUP_WINDOW) this.setPicked(true);
      }
      this.lastMaster = v;
      if (this.picked) {
        this.hooks.setMasterVolume(v);
        this.lastSet = this.hooks.getMasterVolume();
      }
    } catch (e) {
      log('error', 'midi', 'APC master fader failed', e);
    }
  }

  private setPicked(on: boolean): void {
    if (this.picked === on) return;
    this.picked = on;
    if (on) log('info', 'midi', 'APC master fader picked up the master volume');
    this.changed();
  }

  private resetPickup(): void {
    this.lastMaster = -1;
    this.lastSet = -1;
    this.setPicked(false);
  }

  private emit(note: number, down: boolean): void {
    if (note < 64) {
      const x = note & 7, y = note >> 3;
      for (const cb of this.listeners.pad) {
        try { cb(x, y, down); } catch (e) { midiError('apc pad listener threw', e); }
      }
      return;
    }
    const scene = isScene(note);
    const i = note - (scene ? SCENE0 : TRACK0);
    for (const cb of scene ? this.listeners.scene : this.listeners.track) {
      try { cb(i, down); } catch (e) { midiError(`apc ${scene ? 'scene' : 'track'} listener threw`, e); }
    }
  }

  private setlist(): { filled: boolean[]; active: number } | null {
    try {
      return this.hooks.setlistState();
    } catch (e) {
      midiError('setlistState() failed', e);
      return null;
    }
  }

  private saveFaders(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      save(FADERS_KEY, Array.from(this.faders, (v) => Math.round(v * 1000) / 1000));
    }, 300);
  }
}

/** The app-facing view of the driver. Listeners are removed with the app's scope. */
export class ApcFacade implements ApcMini {
  constructor(private readonly d: ApcDriver, private readonly scope: Scope) {}

  get connected(): boolean { return this.d.connected; }
  get shift(): boolean { return this.d.shift; }
  get faders(): Float32Array { return this.d.faders; }

  held(x: number, y: number): boolean {
    return this.d.held(x, y);
  }

  on(ev: 'pad', cb: PadListener): Unsub;
  on(ev: 'fader', cb: FaderListener): Unsub;
  on(ev: 'track' | 'scene', cb: ButtonListener): Unsub;
  on(ev: ApcEvent, cb: PadListener | FaderListener | ButtonListener): Unsub {
    const set = this.d.listeners[ev] as Set<PadListener | FaderListener | ButtonListener> | undefined;
    if (!set) {
      log('warn', 'midi', `apc.on: unknown event "${String(ev)}"`);
      return () => {};
    }
    set.add(cb);
    const off = (): void => { set.delete(cb); };
    this.scope.add(off);
    return off;
  }

  setPad(x: number, y: number, color: ApcColor | null, blink = false): void {
    this.d.setPad(x, y, color, blink);
  }

  setTrack(index: number, state: ApcButtonLed): void {
    this.d.setTrack(index, state);
  }

  setScene(index: number, state: ApcButtonLed): void {
    this.d.setScene(index, state);
  }

  fill(fn: (x: number, y: number) => ApcColor | null): void {
    this.d.fill(fn);
  }

  clear(): void {
    this.d.clear();
  }
}
