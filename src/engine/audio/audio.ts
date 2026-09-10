import * as Tone from 'tone';
import type { AudioAPI, AudioInputHandle, InputKind } from '@sdk';
import { resolveSource, type AudioService, type ParamReader } from '../services';
import type { Scope } from '../scope';
import { FeatureExtractor } from './features';
import { findByName, isHidden, shortNameFor } from '../devices';
import { load, save } from '../persist';
import { log } from '../log';

interface MonitorState { gain: number; muted: boolean }

/** One audio input as seen by the mixer: a stable bus that devices connect into. */
export interface Strip {
  readonly name: string;
  label: string;
  deviceId: string | null;
  connected: boolean;
  /** Stable pre-fader node; apps and the analyser hang off this. */
  readonly bus: GainNode;
  readonly features: FeatureExtractor;
  readonly monitor: GainNode;
  state: MonitorState;
  warning: string | null;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  pending: boolean;
}

const PROCESSING_OFF = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const DEFAULT_INPUT = 'op1';
const ms = (s: number) => `${(s * 1000).toFixed(1)} ms`;

/**
 * device → strip bus ─┬─ analyser (features)
 *                     ├─ app handles (per-app proxy gains)
 *                     └─ monitor gain ─────────────────────┐
 * app bus → app fade → panic gain ─────────────────────────┤
 *                                   master sum → limiter → master gain → destination
 */
export class AudioEngine implements AudioService {
  ctx: AudioContext | null = null;
  readonly strips = new Map<string, Strip>();
  inputs: MediaDeviceInfo[] = [];
  outputs: MediaDeviceInfo[] = [];
  /** Always starts at full and isn't saved, so a pulled-down fader can't silence the next session. */
  masterVolume = 1;
  sinkLabel = load<string>('audio:sink', '');
  masterFeatures: FeatureExtractor | null = null;
  limiter: DynamicsCompressorNode | null = null;
  onChange: () => void = () => {};

  private masterSum!: GainNode;
  private masterGain!: GainNode;
  private appBus!: GainNode;
  private appFade!: GainNode;
  private panicGain!: GainNode;

  async start(): Promise<void> {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    void ctx.resume(); // still inside the Start click
    Tone.setContext(ctx);

    this.masterSum = ctx.createGain();
    this.limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.1 });
    this.masterGain = new GainNode(ctx, { gain: this.masterVolume ** 2 });
    const masterAnalyser = ctx.createAnalyser();
    this.masterSum.connect(this.limiter).connect(this.masterGain).connect(ctx.destination);
    this.masterGain.connect(masterAnalyser);
    this.masterFeatures = new FeatureExtractor(masterAnalyser);
    this.panicGain = ctx.createGain();
    this.panicGain.connect(this.masterSum);
    this.appFade = ctx.createGain();
    this.appFade.connect(this.panicGain);
    this.appBus = ctx.createGain();
    this.appBus.connect(this.appFade);

    ctx.addEventListener('statechange', () => {
      log(ctx.state === 'running' ? 'info' : 'warn', 'audio', `audio context ${ctx.state}`);
      this.onChange();
    });

    // One permission prompt unlocks device labels.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      log('error', 'audio', 'microphone permission denied; audio inputs are unavailable', e);
    }
    await this.refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', () => void this.refreshDevices());
    const sink = this.sinkLabel && this.outputs.find((o) => o.label === this.sinkLabel);
    if (sink) await this.setOutput(sink.deviceId);
    this.strip(DEFAULT_INPUT);
    log('info', 'audio', `${ctx.sampleRate} Hz · base latency ${ms(ctx.baseLatency)} · output latency ${ms(ctx.outputLatency)}`);
  }

  beginFrame(now: number, dt: number): void {
    if (!this.ctx) return;
    for (const s of this.strips.values()) s.features.update(now, dt);
    this.masterFeatures?.update(now, dt);
  }

  /** Get or create the strip for a device name; it binds to the device whenever it's present. */
  strip(name: string): Strip {
    const existing = this.strips.get(name);
    if (existing) return existing;
    const ctx = this.ctx!;
    const state = load<MonitorState>(`audio:monitor:${name}`, { gain: 1, muted: name !== DEFAULT_INPUT });
    const bus = ctx.createGain();
    const analyser = ctx.createAnalyser();
    const monitor = new GainNode(ctx, { gain: state.muted ? 0 : state.gain });
    bus.connect(analyser);
    bus.connect(monitor).connect(this.masterSum);
    const s: Strip = {
      name, label: '', deviceId: null, connected: false, bus, features: new FeatureExtractor(analyser),
      monitor, state, warning: null, stream: null, source: null, pending: false,
    };
    this.strips.set(name, s);
    void this.bind(s);
    this.onChange();
    return s;
  }

  scoped(scope: Scope, params: ParamReader): AudioAPI {
    const self = this;
    return {
      get ctx() { return self.ctx!; },
      get out() { return self.appBus; },
      input: (src) => this.inputHandle(src, scope, params),
      master: { get features() { return self.masterFeatures!; } },
      recorder: () => { throw new Error('the audio recorder is not implemented yet'); },
    };
  }

  setMonitor(name: string, o: Partial<MonitorState>): void {
    const s = this.strips.get(name);
    if (!s || !this.ctx) return;
    s.state = { ...s.state, ...o };
    s.monitor.gain.setTargetAtTime(s.state.muted ? 0 : s.state.gain, this.ctx.currentTime, 0.01);
    save(`audio:monitor:${name}`, s.state);
    this.onChange();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = Math.min(1, Math.max(0, v));
    if (this.ctx) this.masterGain.gain.setTargetAtTime(this.masterVolume ** 2, this.ctx.currentTime, 0.02);
  }

  async setOutput(deviceId: string): Promise<void> {
    if (!this.ctx) return;
    try {
      // setSinkId (Chrome 110+) isn't in TypeScript's DOM types yet.
      await (this.ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId);
      const label = this.outputs.find((o) => o.deviceId === deviceId)?.label ?? '';
      this.sinkLabel = label;
      save('audio:sink', label);
      log('info', 'audio', `output → ${label || 'system default'}`);
    } catch (e) {
      log('error', 'audio', 'could not switch output device', e);
    }
    this.onChange();
  }

  async fadeAppOut(fadeMs: number): Promise<void> {
    if (!this.ctx) return;
    const g = this.appFade.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fadeMs / 1000);
    await new Promise((r) => setTimeout(r, fadeMs));
  }

  /** Detach everything the old app connected, and open a fresh bus for the next one. */
  resetAppBus(): void {
    if (!this.ctx) return;
    this.appBus.disconnect();
    this.appBus = this.ctx.createGain();
    this.appBus.connect(this.appFade);
    const g = this.appFade.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
  }

  setPanic(on: boolean): void {
    if (this.ctx) this.panicGain.gain.setTargetAtTime(on ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  names(kind: InputKind): string[] {
    if (kind !== 'audioIn') return [];
    return this.inputs.map((d) => shortNameFor(d.label) ?? d.label);
  }

  private inputHandle(src: string | { param: string }, scope: Scope, params: ParamReader): AudioInputHandle {
    const ctx = this.ctx!;
    // A per-handle proxy gain, so unmounting cuts off whatever the app connected downstream.
    const proxy = ctx.createGain();
    let strip = this.strip(resolveSource(src, params) || DEFAULT_INPUT);
    strip.bus.connect(proxy);
    if (typeof src !== 'string') {
      scope.add(params.on(src.param, (v) => {
        const next = this.strip(String(v || DEFAULT_INPUT));
        if (next === strip) return;
        strip.bus.disconnect(proxy);
        strip = next;
        strip.bus.connect(proxy);
      }));
    }
    scope.add(() => {
      try { strip.bus.disconnect(proxy); } catch { /* already disconnected */ }
      proxy.disconnect();
    });
    return {
      get alias() { return strip.name; },
      get connected() { return strip.connected; },
      node: proxy,
      get features() { return strip.features; },
      setMonitor: (o) => this.setMonitor(strip.name, o),
    };
  }

  private async refreshDevices(): Promise<void> {
    const all = await navigator.mediaDevices.enumerateDevices();
    const real = (d: MediaDeviceInfo) => d.deviceId !== 'default' && d.deviceId !== 'communications' && !isHidden(d.label);
    this.inputs = all.filter((d) => d.kind === 'audioinput' && real(d));
    this.outputs = all.filter((d) => d.kind === 'audiooutput' && real(d));
    for (const s of this.strips.values()) void this.bind(s);
    this.onChange();
  }

  private async bind(s: Strip): Promise<void> {
    if (s.pending || !this.ctx) return;
    const dev = findByName(s.name, this.inputs);
    const live = s.stream?.getAudioTracks().some((t) => t.readyState === 'live');
    if (dev && live && dev.deviceId === s.deviceId) return;
    this.unbind(s);
    if (!dev) { this.onChange(); return; }
    s.pending = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: dev.deviceId }, channelCount: 2, ...PROCESSING_OFF },
      });
      const track = stream.getAudioTracks()[0];
      const settings = track.getSettings() as MediaTrackSettings & Record<string, unknown>;
      const stillOn = Object.keys(PROCESSING_OFF).filter((k) => settings[k] === true);
      s.warning = stillOn.length ? `processing still on: ${stillOn.join(', ')}` : null;
      s.source = this.ctx.createMediaStreamSource(stream);
      s.source.connect(s.bus);
      s.stream = stream;
      s.deviceId = dev.deviceId;
      s.label = dev.label;
      s.connected = true;
      track.addEventListener('ended', () => {
        log('warn', 'audio', `${s.name} disconnected`);
        this.unbind(s);
        this.onChange();
      });
      log('info', 'audio', `${s.name} → ${dev.label} (${settings.sampleRate ?? '?'} Hz, ${settings.channelCount ?? '?'} ch)`);
      if (s.warning) log('warn', 'audio', `${s.name}: ${s.warning}`);
    } catch (e) {
      log('error', 'audio', `could not open ${dev.label}`, e);
    } finally {
      s.pending = false;
    }
    this.onChange();
  }

  private unbind(s: Strip): void {
    s.source?.disconnect();
    s.stream?.getTracks().forEach((t) => t.stop());
    s.source = null;
    s.stream = null;
    s.deviceId = null;
    s.connected = false;
  }
}
