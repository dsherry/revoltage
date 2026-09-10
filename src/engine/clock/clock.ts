import * as Tone from 'tone';
import type { ClockAPI, ClockEvent, ClockSnapshot } from '@sdk';
import type { ClockService } from '../services';
import type { Scope } from '../scope';
import { load, save } from '../persist';
import { log } from '../log';

type Transport = ReturnType<typeof Tone.getTransport>;
export type MidiClockKind = 'clock' | 'start' | 'continue' | 'stop';

/** What the clock needs from the MIDI service (wired by the engine). */
export interface ClockMidi {
  onClock(cb: (kind: MidiClockKind, t: number, device: string) => void): () => void;
  send(device: string, bytes: number[], atMs?: number): void;
}

const MIDI_PPQ = 24;
const EXT_TIMEOUT_MS = 500;
const SCHEDULING_METHODS = new Set(['schedule', 'scheduleRepeat', 'scheduleOnce']);

/**
 * Tone.Transport is the one timeline. In 'internal' mode it runs at the set BPM
 * and can send MIDI clock; in 'midi' mode it is slaved to incoming MIDI clock
 * (tempo from a regression over recent ticks, position re-aligned every beat).
 */
export class ClockEngine implements ClockService {
  source: 'internal' | 'midi' = load('clock:source', 'internal');
  /** Device followed in 'midi' mode. */
  follow = load<string>('clock:follow', 'op1');
  /** Devices sent MIDI clock in 'internal' mode. */
  sendTo = load<string[]>('clock:sendTo', []);
  onChange: () => void = () => {};

  private transport: Transport | null = null;
  private midi: ClockMidi | null = null;
  private offMidi: (() => void) | null = null;
  private bpm = load<number>('clock:bpm', 120);
  private snap = { source: this.source, bpm: this.bpm, playing: false, beats: 0, bar: 0, beatInBar: 0, phase: 0 };
  private listeners = new Map<ClockEvent, Set<(t: number) => void>>();
  private taps: number[] = [];
  private ext = { ticks: 0, times: [] as number[], last: 0, playing: false, bpm: 120 };

  async start(): Promise<void> {
    const t = Tone.getTransport();
    this.transport = t;
    t.bpm.value = this.bpm;
    t.scheduleRepeat((time) => {
      const step = Math.round(t.getTicksAtTime(time) / (t.PPQ / 4));
      this.emit('step16', time);
      if (step % 4 === 0) this.emit('beat', time);
      if (step % 16 === 0) this.emit('bar', time);
    }, '16n', 0);
    t.scheduleRepeat((time) => {
      if (this.source === 'internal') this.sendClock([0xf8], time);
    }, `${t.PPQ / MIDI_PPQ}i`, 0);
    t.on('start', (time) => {
      if (this.source === 'internal') this.sendClock([0xfa], time);
      this.emit('start', time);
      this.onChange();
    });
    t.on('stop', (time) => {
      if (this.source === 'internal') this.sendClock([0xfc], time);
      this.emit('stop', time);
      this.onChange();
    });
  }

  /** Called by the engine once the MIDI service is running. */
  attachMidi(midi: ClockMidi): void {
    this.midi = midi;
    this.offMidi?.();
    this.offMidi = midi.onClock((kind, t, device) => {
      if (this.source === 'midi' && device === this.follow) this.onMidiClock(kind, t);
    });
  }

  beginFrame(now: number): void {
    const t = this.transport;
    if (!t) return;
    const s = this.snap;
    s.source = this.source;
    if (this.source === 'midi') {
      const e = this.ext;
      if (e.playing && now - e.last > EXT_TIMEOUT_MS) e.playing = false;
      const tickMs = 60000 / (e.bpm * MIDI_PPQ);
      s.playing = e.playing;
      s.bpm = e.bpm;
      s.beats = (e.ticks + (e.playing ? Math.min(1, (now - e.last) / tickMs) : 0)) / MIDI_PPQ;
    } else {
      s.playing = t.state === 'started';
      s.bpm = t.bpm.value;
      s.beats = t.ticks / t.PPQ;
    }
    s.phase = s.beats % 1;
    s.beatInBar = Math.floor(s.beats) % 4;
    s.bar = Math.floor(s.beats / 4);
  }

  snapshot(): ClockSnapshot {
    return this.snap;
  }

  scoped(scope: Scope): ClockAPI {
    const self = this;
    const transport = this.transport!;
    // Track what the app schedules on the shared transport so unmount clears it.
    const ids: number[] = [];
    const scopedTransport = new Proxy(transport, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== 'function') return v;
        if (typeof prop === 'string' && SCHEDULING_METHODS.has(prop)) {
          return (...args: unknown[]) => {
            const id = (v as (...a: unknown[]) => number).apply(target, args);
            ids.push(id);
            return id;
          };
        }
        return v.bind(target);
      },
    });
    scope.add(() => { for (const id of ids) transport.clear(id); });
    const snap = this.snap;
    return {
      get source() { return snap.source; },
      get bpm() { return snap.bpm; },
      get playing() { return snap.playing; },
      get beats() { return snap.beats; },
      get bar() { return snap.bar; },
      get beatInBar() { return snap.beatInBar; },
      get phase() { return snap.phase; },
      on(ev, cb) {
        let set = self.listeners.get(ev);
        if (!set) self.listeners.set(ev, (set = new Set()));
        set.add(cb);
        return scope.add(() => { set.delete(cb); });
      },
      transport: scopedTransport,
    };
  }

  setBpm(bpm: number): void {
    this.bpm = Math.min(300, Math.max(30, bpm));
    if (this.transport && this.source === 'internal') this.transport.bpm.rampTo(this.bpm, 0.05);
    save('clock:bpm', this.bpm);
    this.onChange();
  }

  /** Tap tempo: the average of the last few intervals, reset after a 2 s gap. */
  tap(now = performance.now()): void {
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length >= 2) {
      const span = this.taps[this.taps.length - 1] - this.taps[0];
      this.setBpm((60000 * (this.taps.length - 1)) / span);
    }
  }

  togglePlay(): void {
    const t = this.transport;
    if (!t || this.source !== 'internal') return;
    if (t.state === 'started') t.stop();
    else t.start('+0.05');
  }

  setSource(source: 'internal' | 'midi'): void {
    this.source = source;
    save('clock:source', source);
    const t = this.transport;
    if (t) {
      t.stop();
      if (source === 'internal') t.bpm.value = this.bpm;
    }
    this.ext.playing = false;
    log('info', 'clock', source === 'midi' ? `following MIDI clock from ${this.follow}` : 'internal clock');
    this.onChange();
  }

  setFollow(device: string): void {
    this.follow = device;
    save('clock:follow', device);
    this.onChange();
  }

  setSendTo(devices: string[]): void {
    this.sendTo = devices;
    save('clock:sendTo', devices);
    this.onChange();
  }

  private onMidiClock(kind: MidiClockKind, t: number): void {
    const tr = this.transport;
    const e = this.ext;
    if (!tr) return;
    if (kind === 'start') {
      e.ticks = 0;
      e.times = [];
      e.playing = true;
      e.last = t;
      tr.stop();
      tr.ticks = 0;
      tr.start();
    } else if (kind === 'continue') {
      e.playing = true;
      e.last = t;
      tr.start();
    } else if (kind === 'stop') {
      e.playing = false;
      tr.pause();
    } else {
      e.ticks++;
      e.last = t;
      e.times.push(t);
      if (e.times.length > 48) e.times.shift();
      const bpm = regressionBpm(e.times);
      if (bpm) {
        e.bpm = bpm;
        if (Math.abs(tr.bpm.value - bpm) > 0.3) tr.bpm.value = bpm;
      }
      if (e.ticks % MIDI_PPQ === 0 && tr.state === 'started') {
        const expected = (e.ticks / MIDI_PPQ) * tr.PPQ;
        if (Math.abs(tr.ticks - expected) > tr.PPQ * 0.05) tr.ticks = expected;
      }
    }
  }

  private sendClock(bytes: number[], audioTime: number): void {
    if (!this.midi || !this.sendTo.length) return;
    const raw = Tone.getContext().rawContext as AudioContext;
    const atMs = performance.now() + (audioTime - raw.currentTime + (raw.outputLatency || 0)) * 1000;
    for (const d of this.sendTo) this.midi.send(d, bytes, atMs);
  }

  private emit(ev: ClockEvent, time: number): void {
    const set = this.listeners.get(ev);
    if (!set) return;
    for (const cb of set) {
      try { cb(time); } catch (e) { log('error', 'clock', `${ev} listener threw`, e); }
    }
  }
}

/** BPM from a least-squares fit of tick timestamps (ms) against tick index. */
function regressionBpm(times: number[]): number | null {
  const n = times.length;
  if (n < 8) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += times[i]; sxx += i * i; sxy += i * times[i];
  }
  const msPerTick = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return msPerTick > 0 ? 60000 / (msPerTick * MIDI_PPQ) : null;
}
