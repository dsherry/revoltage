import { WebMidi, type Input, type Output, type MessageEvent as WmMessageEvent } from 'webmidi';
import type { InputKind, MidiAPI, MidiEvent, MidiInHandle, MidiOutHandle, Unsub } from '@sdk';
import { resolveSource, type MidiService, type ParamReader } from '../services';
import type { Scope } from '../scope';
import { isHidden, matchesName, shortNameFor } from '../devices';
import { log } from '../log';
import { ApcDriver, ApcFacade, midiError } from './apc-mini';

/** What the MIDI service needs from the engine for the reserved APC controls (spec §9). */
export interface MidiHooks {
  loadSlot(i: number): void;
  toggleBlackout(): void;
  togglePanic(): void;
  /** 0..1 */
  setMasterVolume(v: number): void;
  getMasterVolume(): number;
  /** The 8 setlist slots, for the Shift overlay on the scene LEDs. */
  setlistState(): { filled: boolean[]; active: number };
}

export type ClockKind = 'clock' | 'start' | 'continue' | 'stop';
export type ClockListener = (kind: ClockKind, t: number, device: string) => void;

export interface MidiPortInfo {
  /** Short name when one matches (e.g. 'apc'), else the system name. */
  name: string;
  /** System port name. */
  label: string;
  input: boolean;
  output: boolean;
  connected: boolean;
}

/** One system port name. Outlives unplugging, so handles and state survive reconnects. */
interface Port {
  readonly label: string;
  readonly name: string;
  input: Input | null;
  output: Output | null;
  inConnected: boolean;
  outConnected: boolean;
  /** Latest CC values, [(ch-1)*128 + cc] → 0..1. */
  readonly ccs: Float32Array;
  /** Held notes per channel (index ch-1), and across all channels. */
  readonly held: Set<number>[];
  readonly heldAny: Set<number>;
  /** Notes an app turned on here and hasn't turned off, [(ch-1)*128 + note]. */
  readonly sounding: Uint8Array;
}

type InType = Parameters<MidiInHandle['on']>[0];
type Resolver = () => Port | null;
interface Sub { resolve: Resolver; type: InType; cb: (e: MidiEvent) => void }

const RECENT_MAX = 200;
const QUEUE_MAX = 4096;
/** How long Start waits on the MIDI permission prompt before moving on. */
const ENABLE_WAIT_MS = 3000;
const RESCAN_MS = 1000;
/** Panic note-offs are repeated this much later, to catch note-ons already scheduled ahead. */
const PANIC_REPEAT_MS = 200;
const EMPTY: ReadonlySet<number> = new Set();

const ch4 = (ch: number): number => Math.min(15, Math.max(0, (ch | 0) - 1));
const b7 = (n: number): number => Math.min(127, Math.max(0, n | 0));
const u7 = (v: number): number => (v > 0 ? Math.min(127, Math.round(v * 127)) : 0);
const ccIndex = (ch: number, n: number): number => {
  const c = (ch | 0) - 1, k = n | 0;
  return c >= 0 && c < 16 && k >= 0 && k < 128 ? c * 128 + k : -1;
};

function mk(
  device: string, type: MidiEvent['type'], ch: number, note: number | undefined, velocity: number | undefined,
  cc: number | undefined, value: number | undefined, t: number, raw: Uint8Array,
): MidiEvent {
  return { device, type, ch, note, velocity, cc, value, t, raw };
}

/** Raw bytes → MidiEvent. System messages other than sysex (and realtime, handled earlier) are ignored. ch is 0 for sysex. */
function parse(device: string, raw: Uint8Array, t: number): MidiEvent | null {
  const st = raw[0];
  if (st === 0xf0) return mk(device, 'sysex', 0, undefined, undefined, undefined, undefined, t, raw);
  if (st < 0x80 || st > 0xef) return null;
  const ch = (st & 0x0f) + 1, d1 = raw[1] | 0, d2 = raw[2] | 0;
  switch (st & 0xf0) {
    case 0x80: return mk(device, 'noteoff', ch, d1, d2 / 127, undefined, undefined, t, raw);
    case 0x90: return mk(device, d2 > 0 ? 'noteon' : 'noteoff', ch, d1, d2 / 127, undefined, undefined, t, raw);
    case 0xa0: return mk(device, 'aftertouch', ch, d1, undefined, undefined, d2 / 127, t, raw);
    case 0xb0: return mk(device, 'cc', ch, undefined, undefined, d1, d2 / 127, t, raw);
    case 0xc0: return mk(device, 'program', ch, undefined, undefined, undefined, d1 / 127, t, raw);
    case 0xd0: return mk(device, 'aftertouch', ch, undefined, undefined, undefined, d1 / 127, t, raw);
    default: {
      const v = ((d2 << 7) | d1) - 8192; // -1..1
      return mk(device, 'pitchbend', ch, undefined, undefined, undefined, v >= 0 ? v / 8191 : v / 8192, t, raw);
    }
  }
}

/**
 * Web MIDI through WEBMIDI.js: hot-plugged ports, raw-byte parsing into MidiEvents, app handles
 * that follow device names, the APC mini driver and the reserved global controls (spec §7.6, §9).
 */
export class MidiEngine implements MidiService {
  /** Set by the engine; called on hot-plug and APC state changes. */
  onChange: () => void = () => {};
  /** MIDI access granted. */
  enabled = false;
  /** Why MIDI is offline (unsupported, permission denied), if it is. */
  error: string | null = null;
  readonly apc: ApcDriver;

  private started = false;
  /** Bumped whenever ports appear or change state; handles re-resolve their device names on change. */
  private gen = 0;
  private readonly byLabel = new Map<string, Port>();
  private readonly byInput = new Map<Input, Port>();
  private readonly subs = new Set<Sub>();
  private readonly clockSubs = new Set<ClockListener>();
  private readonly eventSubs = new Set<(e: MidiEvent) => void>();
  /** Outputs the current app has sent to (for allNotesOff). */
  private readonly used = new Set<Port>();
  private readonly recentBuf: MidiEvent[] = [];
  private queue: MidiEvent[] = [];
  private drained: MidiEvent[] = [];
  private apcIn: Port | null = null;
  private apcOut: Port | null = null;
  private op1Seen = false;
  private readonly scratch = new Uint8Array(3);
  private readonly when = { time: 0 };

  constructor(hooks: MidiHooks) {
    this.apc = new ApcDriver(hooks, (note, velocity) => this.send3(this.apcOut, 0x90, note, velocity), () => this.onChange());
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!WebMidi.supported) {
      this.fail('Web MIDI is not supported in this browser');
      return;
    }
    const ready = WebMidi.enable({ sysex: false }).then(
      () => this.enabledOk(),
      (e: unknown) => {
        // Access was granted but a port failed to open: the rest still works.
        if (WebMidi.enabled) {
          log('warn', 'midi', 'some MIDI ports failed to open', e);
          this.enabledOk();
        } else {
          this.fail('MIDI is unavailable (permission denied?)', e);
        }
      },
    );
    // An unanswered permission prompt mustn't hold up the rest of Start; devices appear once it's granted.
    let timer = 0;
    const timedOut = await Promise.race([
      ready.then(() => false),
      new Promise<boolean>((resolve) => { timer = window.setTimeout(() => resolve(true), ENABLE_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    if (timedOut) log('warn', 'midi', 'still waiting for MIDI access; devices will appear once it is granted');
  }

  scoped(scope: Scope, params: ParamReader): MidiAPI {
    const self = this;
    let apc: ApcFacade | null = null;
    let op1: { in: MidiInHandle; out: MidiOutHandle } | null = null;
    return {
      input: (src) => this.inHandle(src, params, scope),
      output: (src) => this.outHandle(src, params),
      get apc() {
        if (!self.apcIn && !self.apcOut) return null;
        return (apc ??= new ApcFacade(self.apc, scope));
      },
      get op1() {
        if (!self.op1Seen) return null;
        return (op1 ??= { in: self.inHandle('op1', params, scope), out: self.outHandle('op1', params) });
      },
    };
  }

  /** Events since the last call, minus consumed global controls and clock bytes. Valid until the next call. */
  drain(): readonly MidiEvent[] {
    const out = this.drained;
    out.length = 0;
    this.drained = this.queue;
    this.queue = out;
    return this.drained;
  }

  allNotesOff(): void {
    for (const p of this.used) this.silence(p);
    const op1 = this.find('op1', 'out');
    if (op1 && !this.used.has(op1)) this.silence(op1);
  }

  appUnmounted(): void {
    this.apc.clear();
    // Raw sends to the APC may have lit LEDs behind the driver's back.
    if (this.apcOut && this.used.has(this.apcOut)) this.apc.invalidate();
    this.used.clear();
    // Scope disposal already removed these; this is a safety net.
    this.subs.clear();
    this.apc.clearListeners();
  }

  endFrame(now: number): void {
    this.apc.flush(now);
  }

  names(kind: InputKind): string[] {
    const out: string[] = [];
    if (kind !== 'midiIn' && kind !== 'midiOut') return out;
    for (const p of this.byLabel.values()) {
      const live = kind === 'midiIn' ? p.inConnected : p.outConnected;
      if (live && !isHidden(p.label) && !out.includes(p.name)) out.push(p.name);
    }
    return out;
  }

  /** Every port seen since Start, for the Devices panel. */
  ports(): MidiPortInfo[] {
    return Array.from(this.byLabel.values(), (p) => ({
      name: p.name, label: p.label, input: p.input !== null, output: p.output !== null,
      connected: p.inConnected || p.outConnected,
    }));
  }

  /** The last 200 events, oldest first, including consumed global controls (not clock bytes). */
  recent(): readonly MidiEvent[] {
    return this.recentBuf;
  }

  /** Every incoming event as it arrives (same set as recent()), for the MIDI monitor. */
  onEvent(cb: (e: MidiEvent) => void): Unsub {
    this.eventSubs.add(cb);
    return () => { this.eventSubs.delete(cb); };
  }

  /** Realtime clock bytes from any input (for the clock service); t is the performance.now() timestamp. */
  onClock(cb: ClockListener): Unsub {
    this.clockSubs.add(cb);
    return () => { this.clockSubs.delete(cb); };
  }

  /* ------------------------------------------------------------- handles */

  /** Resolves a device reference to a port, re-resolving only when the name or the port set changes. */
  private resolver(src: string | { param: string }, params: ParamReader, dir: 'in' | 'out'): Resolver {
    let key = '', gen = -1, port: Port | null = null;
    return () => {
      const k = resolveSource(src, params);
      if (k !== key || gen !== this.gen) {
        key = k;
        gen = this.gen;
        port = this.find(k, dir);
      }
      return port;
    };
  }

  private inHandle(src: string | { param: string }, params: ParamReader, scope: Scope): MidiInHandle {
    const resolve = this.resolver(src, params, 'in');
    return {
      get connected() { return resolve()?.inConnected ?? false; },
      on: (type, cb) => {
        const sub: Sub = { resolve, type, cb };
        this.subs.add(sub);
        const off = (): void => { this.subs.delete(sub); };
        scope.add(off);
        return off;
      },
      cc: (ch, n) => {
        const p = resolve(), i = ccIndex(ch, n);
        return p && i >= 0 ? p.ccs[i] : 0;
      },
      held: (ch) => {
        const p = resolve();
        if (!p) return EMPTY;
        if (ch === undefined) return p.heldAny;
        const c = (ch | 0) - 1;
        return c >= 0 && c < 16 ? p.held[c] : EMPTY;
      },
    };
  }

  private outHandle(src: string | { param: string }, params: ParamReader): MidiOutHandle {
    const resolve = this.resolver(src, params, 'out');
    const note = (st: number, n: number, v: number, ch: number, atMs?: number): void => {
      const p = resolve();
      if (!p) return;
      this.used.add(p);
      const c = ch4(ch), k = b7(n);
      if (this.send3(p, st | c, k, v, atMs)) p.sounding[c * 128 + k] = st === 0x90 && v > 0 ? 1 : 0;
    };
    return {
      get connected() { return resolve()?.outConnected ?? false; },
      // A tiny positive velocity must not round to 0, which would be a note-off.
      noteOn: (n, velocity = 1, ch = 1, atMs) => note(0x90, n, velocity > 0 ? Math.max(1, u7(velocity)) : 0, ch, atMs),
      noteOff: (n, ch = 1, atMs) => note(0x80, n, 0, ch, atMs),
      cc: (n, value, ch = 1, atMs) => {
        const p = resolve();
        if (!p) return;
        this.used.add(p);
        this.send3(p, 0xb0 | ch4(ch), b7(n), u7(value), atMs);
      },
      send: (bytes, atMs) => {
        const p = resolve();
        if (!p) return;
        this.used.add(p);
        const kind = bytes[0] & 0xf0;
        if ((kind === 0x90 || kind === 0x80) && bytes.length >= 3) {
          p.sounding[(bytes[0] & 0x0f) * 128 + (bytes[1] & 0x7f)] = kind === 0x90 && bytes[2] > 0 ? 1 : 0;
        }
        this.write(p, bytes, atMs);
      },
      allNotesOff: () => this.silence(resolve()),
    };
  }

  /** First non-hidden port matching `name`, preferring a connected one; else one seen earlier. */
  private find(name: string, dir: 'in' | 'out'): Port | null {
    if (!name) return null;
    let seen: Port | null = null;
    for (const p of this.byLabel.values()) {
      if (isHidden(p.label) || !matchesName(name, p.label)) continue;
      if (dir === 'in' ? p.inConnected : p.outConnected) return p;
      if (!seen && (dir === 'in' ? p.input : p.output)) seen = p;
    }
    return seen;
  }

  /* -------------------------------------------------------------- output */

  private write(p: Port | null, bytes: number[] | Uint8Array, atMs?: number): boolean {
    if (!p?.outConnected || !p.output) return false;
    try {
      if (atMs === undefined) {
        p.output.send(bytes);
      } else {
        this.when.time = atMs;
        p.output.send(bytes, this.when);
      }
      return true;
    } catch (e) {
      midiError(`send to ${p.label} failed`, e);
      return false;
    }
  }

  private send3(p: Port | null, st: number, d1: number, d2: number, atMs?: number): boolean {
    const b = this.scratch;
    b[0] = st;
    b[1] = d1;
    b[2] = d2;
    return this.write(p, b, atMs); // Chrome copies the bytes during send(), so the buffer can be reused
  }

  /** Note-offs for every note an app left on (sent now and again shortly after), then CC 123 on all channels. */
  private silence(p: Port | null): void {
    if (!p?.outConnected) return;
    const later = performance.now() + PANIC_REPEAT_MS;
    const s = p.sounding;
    for (let i = 0; i < s.length; i++) {
      if (!s[i]) continue;
      s[i] = 0;
      const st = 0x80 | (i >> 7);
      this.send3(p, st, i & 0x7f, 0);
      this.send3(p, st, i & 0x7f, 0, later);
    }
    for (let c = 0; c < 16; c++) this.send3(p, 0xb0 | c, 123, 0);
  }

  /* ------------------------------------------------------------ hot-plug */

  private enabledOk(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.error = null;
    WebMidi.addListener('connected', this.onPortsChanged);
    WebMidi.addListener('disconnected', this.onPortsChanged);
    // Backstop: WEBMIDI.js only reports some port state transitions.
    window.setInterval(this.onPortsChanged, RESCAN_MS);
    this.onPortsChanged();
    log('info', 'midi', `MIDI enabled, ${this.byLabel.size} port name(s)`);
    this.onChange();
  }

  private fail(msg: string, e?: unknown): void {
    this.error = msg;
    if (e === undefined) log('error', 'midi', msg);
    else log('error', 'midi', msg, e);
    this.onChange();
  }

  private readonly onPortsChanged = (): void => {
    try {
      this.refresh();
    } catch (e) {
      midiError('MIDI port rescan failed', e);
    }
  };

  private portFor(label: string): Port {
    let p = this.byLabel.get(label);
    if (!p) {
      p = {
        label, name: shortNameFor(label) ?? label, input: null, output: null, inConnected: false, outConnected: false,
        ccs: new Float32Array(16 * 128), held: Array.from({ length: 16 }, () => new Set<number>()),
        heldAny: new Set<number>(), sounding: new Uint8Array(16 * 128),
      };
      this.byLabel.set(label, p);
    }
    return p;
  }

  /** Reconcile ports with WEBMIDI.js; idempotent, so it runs on every hot-plug event and on a timer. */
  private refresh(): void {
    if (!WebMidi.enabled) return;
    const ins = new Map<Port, Input>();
    const outs = new Map<Port, Output>();
    for (const input of WebMidi.inputs) {
      if (input.state !== 'connected') continue;
      let p = this.byInput.get(input);
      if (!p) {
        // WEBMIDI.js reuses an Input when the same port comes back, so each gets one listener, once.
        p = this.portFor(input.name);
        this.byInput.set(input, p);
        input.addListener('midimessage', this.onMessage);
      }
      if (!ins.has(p)) ins.set(p, input);
    }
    for (const output of WebMidi.outputs) {
      if (output.state !== 'connected') continue;
      const p = this.portFor(output.name);
      if (!outs.has(p)) outs.set(p, output);
    }

    let changed = false;
    for (const p of this.byLabel.values()) {
      const input = ins.get(p) ?? null, output = outs.get(p) ?? null;
      if (input) p.input = input;
      if (output) p.output = output;
      const inNow = input !== null, outNow = output !== null;
      if (inNow === p.inConnected && outNow === p.outConnected) continue;
      const was = p.inConnected || p.outConnected, is = inNow || outNow;
      p.inConnected = inNow;
      p.outConnected = outNow;
      changed = true;
      if (!outNow) p.sounding.fill(0);
      if (!inNow) this.releaseHeld(p);
      if (was !== is) log(is ? 'info' : 'warn', 'midi', `${p.label} ${is ? 'connected' : 'disconnected'}`);
    }
    if (!changed) return;

    this.gen++;
    this.apcIn = this.find('apc', 'in');
    this.apcOut = this.find('apc', 'out');
    this.op1Seen = this.find('op1', 'in') !== null || this.find('op1', 'out') !== null;
    this.syncApc();
    this.onChange();
  }

  private syncApc(): void {
    const d = this.apc;
    const inNow = this.apcIn?.inConnected ?? false;
    const outNow = this.apcOut?.outConnected ?? false;
    if (inNow && !d.inConnected) d.inputUp();
    else if (!inNow && d.inConnected) d.inputLost();
    if (outNow && !d.outConnected) d.outputUp(performance.now());
    else if (!outNow && d.outConnected) d.outputLost();
  }

  /** Unplugged mid-note: send apps the note-offs that will never arrive. */
  private releaseHeld(p: Port): void {
    const t = performance.now();
    for (let c = 0; c < 16; c++) {
      if (!p.held[c].size) continue;
      for (const note of [...p.held[c]]) {
        const ev = mk(p.name, 'noteoff', c + 1, note, 0, undefined, undefined, t, Uint8Array.of(0x80 | c, note, 0));
        this.pushRecent(ev);
        this.deliver(p, ev);
      }
    }
  }

  /* --------------------------------------------------------------- input */

  private readonly onMessage = (e: WmMessageEvent): void => {
    try {
      const port = this.byInput.get(e.port) ?? this.portFor(e.port.name);
      const raw = e.message.rawData;
      const st = raw[0];
      const t = e.timestamp > 0 ? e.timestamp : performance.now();
      if (st >= 0xf8) {
        this.realtime(port, st, t, raw);
        return;
      }
      const ev = parse(port.name, raw, t);
      if (!ev) return;
      this.pushRecent(ev);
      if (port === this.apcIn && st < 0xf0 && this.apc.handle(st, raw[1], raw[2])) return;
      this.deliver(port, ev);
    } catch (err) {
      midiError('MIDI input handler failed', err);
    }
  };

  private realtime(port: Port, st: number, t: number, raw: Uint8Array): void {
    const kind: ClockKind | null =
      st === 0xf8 ? 'clock' : st === 0xfa ? 'start' : st === 0xfb ? 'continue' : st === 0xfc ? 'stop' : null;
    if (!kind) return; // active sensing, reset
    for (const cb of this.clockSubs) {
      try { cb(kind, t, port.name); } catch (e) { midiError('MIDI clock listener threw', e); }
    }
    let ev: MidiEvent | null = null;
    for (const s of this.subs) {
      if (s.type !== 'clock' || s.resolve() !== port) continue;
      ev ??= mk(port.name, 'clock', 0, undefined, undefined, undefined, undefined, t, raw);
      try { s.cb(ev); } catch (e) { midiError('MIDI clock listener threw', e); }
    }
  }

  /** Update per-device state, queue for drain(), and fire app listeners. */
  private deliver(port: Port, ev: MidiEvent): void {
    const c = ev.ch - 1;
    if (ev.type === 'noteon') {
      port.held[c].add(ev.note!);
      port.heldAny.add(ev.note!);
    } else if (ev.type === 'noteoff') {
      this.unhold(port, c, ev.note!);
    } else if (ev.type === 'cc') {
      port.ccs[c * 128 + ev.cc!] = ev.value!;
    }
    if (this.queue.length < QUEUE_MAX) this.queue.push(ev);
    for (const s of this.subs) {
      if (s.type !== ev.type && s.type !== 'message') continue;
      if (s.resolve() !== port) continue;
      try { s.cb(ev); } catch (e) { midiError(`MIDI ${ev.type} listener threw`, e); }
    }
  }

  private unhold(port: Port, c: number, note: number): void {
    port.held[c].delete(note);
    if (!port.heldAny.has(note)) return;
    for (const s of port.held) if (s.has(note)) return;
    port.heldAny.delete(note);
  }

  private pushRecent(ev: MidiEvent): void {
    const r = this.recentBuf;
    if (r.length >= RECENT_MAX) r.shift();
    r.push(ev);
    for (const cb of this.eventSubs) {
      try { cb(ev); } catch (e) { midiError('MIDI monitor listener threw', e); }
    }
  }
}
