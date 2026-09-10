import type { WebGLRenderer } from 'three';
import type * as Tone from 'tone';
import type { ParamSchema, Params } from './params';

export type Unsub = () => void;
export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }
export interface Rect { x: number; y: number; w: number; h: number }

/* ------------------------------------------------------------------ surfaces */

export type SurfaceKind = '2d' | 'webgl2' | 'three' | 'p5';

export interface SurfaceBase {
  readonly canvas: HTMLCanvasElement;
  /** Size in device pixels (follows the output window × render scale). */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}
export interface Surface2D extends SurfaceBase { readonly g2d: CanvasRenderingContext2D }
export interface SurfaceWebGL2 extends SurfaceBase { readonly gl: WebGL2RenderingContext }
export interface SurfaceThree extends SurfaceBase { readonly renderer: WebGLRenderer }
// p5's bundled types are incomplete, so the instance is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SurfaceP5 extends SurfaceBase { readonly p: any }

export type Surface<K extends SurfaceKind> =
  K extends '2d' ? Surface2D :
  K extends 'webgl2' ? SurfaceWebGL2 :
  K extends 'three' ? SurfaceThree :
  SurfaceP5;

/* --------------------------------------------------------------------- clock */

export interface ClockSnapshot {
  readonly source: 'internal' | 'midi';
  readonly bpm: number;
  readonly playing: boolean;
  /** Continuous beats since start. */
  readonly beats: number;
  readonly bar: number;
  readonly beatInBar: number;
  /** 0..1 within the current beat. */
  readonly phase: number;
}
export type ClockEvent = 'beat' | 'bar' | 'step16' | 'start' | 'stop';
export interface ClockAPI extends ClockSnapshot {
  on(ev: ClockEvent, cb: (audioTime: number) => void): Unsub;
  /** Tone.js transport, for sample-accurate audio scheduling. */
  readonly transport: ReturnType<typeof Tone.getTransport>;
}

/* --------------------------------------------------------------------- audio */

export interface AudioFeatures {
  /** Linear 0..1. */
  readonly rms: number;
  readonly peak: number;
  /** dBFS. */
  readonly db: number;
  /** rms mapped to 0..1 over [-60, 0] dB. */
  readonly level: number;
  /** 8 log-spaced bands, 40 Hz–16 kHz, dB-mapped to 0..1. */
  readonly bands: Float32Array;
  readonly bass: number;
  readonly mid: number;
  readonly treble: number;
  /** Adaptive-normalized 0..1: divided by a slowly decaying running max. */
  readonly bassAuto: number;
  readonly midAuto: number;
  readonly trebleAuto: number;
  readonly levelAuto: number;
  /** Spectral centroid in Hz. */
  readonly centroid: number;
  readonly flux: number;
  /** True on the frame an onset fired. */
  readonly onset: boolean;
  readonly onsetStrength: number;
  /** Read-only analyser buffers (dB spectrum, time-domain waveform). */
  readonly spectrum: Float32Array;
  readonly waveform: Float32Array;
  /** Computed on demand. */
  pitch(): { hz: number; clarity: number } | null;
}

export interface AudioInputHandle {
  readonly alias: string;
  readonly connected: boolean;
  /** Stable pre-fader stereo node; survives device swaps and dropouts. */
  readonly node: AudioNode;
  /** Pre-fader analysis, updated every frame. */
  readonly features: AudioFeatures;
  /** This input's level in the output mix. */
  setMonitor(o: { gain?: number; muted?: boolean }): void;
}

export interface Recorder {
  start(): void;
  stop(): Promise<AudioBuffer>;
  readonly recording: boolean;
  readonly seconds: number;
}

export interface AudioAPI {
  /** The shared AudioContext; Tone.js is bound to it. */
  readonly ctx: AudioContext;
  /** The app's audio bus. Connect synths and effects here. */
  readonly out: AudioNode;
  /** A device name, or `{ param }` to follow an `input` param. */
  input(src: string | { param: string }): AudioInputHandle;
  readonly master: { readonly features: AudioFeatures };
  recorder(src: AudioNode | AudioInputHandle, opts?: { maxSeconds?: number }): Recorder;
}

/* ---------------------------------------------------------------------- midi */

export interface MidiEvent {
  /** Name the device was matched by (e.g. 'apc', 'op1', or its system name). */
  readonly device: string;
  readonly type: 'noteon' | 'noteoff' | 'cc' | 'pitchbend' | 'aftertouch' | 'program' | 'clock' | 'sysex';
  /** 1–16. */
  readonly ch: number;
  readonly note?: number;
  /** 0..1. */
  readonly velocity?: number;
  readonly cc?: number;
  /** 0..1. */
  readonly value?: number;
  /** performance.now() timebase. */
  readonly t: number;
  readonly raw: Uint8Array;
}

export interface MidiInHandle {
  readonly connected: boolean;
  /** Push callback; auto-removed when the app unmounts. */
  on(type: 'noteon' | 'noteoff' | 'cc' | 'pitchbend' | 'clock' | 'message', cb: (e: MidiEvent) => void): Unsub;
  /** Latest CC value 0..1. */
  cc(ch: number, n: number): number;
  held(ch?: number): ReadonlySet<number>;
}

export interface MidiOutHandle {
  readonly connected: boolean;
  /** velocity 0..1; atMs is a performance.now() time for scheduled sends. */
  noteOn(note: number, velocity?: number, ch?: number, atMs?: number): void;
  noteOff(note: number, ch?: number, atMs?: number): void;
  /** value 0..1. */
  cc(n: number, value: number, ch?: number, atMs?: number): void;
  send(bytes: number[] | Uint8Array, atMs?: number): void;
  allNotesOff(): void;
}

export type ApcColor = 'green' | 'red' | 'yellow';
export type ApcButtonLed = 'off' | 'on' | 'blink';

/** Akai APC mini (mk1). Pads are addressed with (0,0) at the bottom-left. */
export interface ApcMini {
  readonly connected: boolean;
  readonly shift: boolean;
  /** Faders 1–8 as 0..1 (the master fader is reserved by the platform). */
  readonly faders: Float32Array;
  held(x: number, y: number): boolean;
  on(ev: 'pad', cb: (x: number, y: number, down: boolean) => void): Unsub;
  on(ev: 'fader', cb: (index: number, value: number) => void): Unsub;
  on(ev: 'track' | 'scene', cb: (index: number, down: boolean) => void): Unsub;
  setPad(x: number, y: number, color: ApcColor | null, blink?: boolean): void;
  setTrack(index: number, state: ApcButtonLed): void;
  setScene(index: number, state: ApcButtonLed): void;
  fill(fn: (x: number, y: number) => ApcColor | null): void;
  clear(): void;
}

export interface MidiAPI {
  input(src: string | { param: string }): MidiInHandle;
  output(src: string | { param: string }): MidiOutHandle;
  /** Present when an APC mini is connected. */
  readonly apc: ApcMini | null;
  readonly op1: { readonly in: MidiInHandle; readonly out: MidiOutHandle } | null;
}

/* -------------------------------------------------------------------- vision */

export interface Landmark { x: number; y: number; z: number; visibility?: number }
export interface Person {
  readonly id: number;
  /** 33 landmarks in MediaPipe order, normalized image coords. */
  readonly landmarks: readonly Landmark[];
  readonly bbox: Rect;
  readonly center: Vec2;
  /** Body-heights per second, smoothed. */
  readonly speed: number;
}
export type GestureName =
  'None' | 'Closed_Fist' | 'Open_Palm' | 'Pointing_Up' | 'Thumb_Down' | 'Thumb_Up' | 'Victory' | 'ILoveYou';
export interface Hand {
  /** Stable while the hand stays tracked. */
  readonly id: number;
  /** performance.now() of the result that last updated this hand (under load, hands skip frames). */
  readonly seen: number;
  readonly handedness: 'Left' | 'Right';
  /** 21 landmarks, normalized image coords. */
  readonly landmarks: readonly Landmark[];
  readonly speed: number;
  readonly gesture: { readonly name: GestureName; readonly score: number };
}
/** Normalized polygon; a rectangle is 4 points. */
export interface Zone { name: string; points: [number, number][] }
export interface ZoneState { readonly motion: number; readonly active: boolean; readonly since: number }
export interface Mask { readonly width: number; readonly height: number; readonly bitmap: ImageBitmap; readonly data: Uint8Array }

export interface TrackOpts {
  pose?: boolean | { model?: 'lite' | 'full'; maxPeople?: number };
  hands?: boolean | { maxHands?: number };
  mask?: boolean;
  zones?: Zone[] | { param: string };
}
export interface VisionHandle {
  readonly connected: boolean;
  readonly fps: number;
  readonly latencyMs: number;
  readonly updatedAt: number;
  readonly people: readonly Person[];
  readonly hands: readonly Hand[];
  readonly mask: Mask | null;
  readonly zones: Readonly<Record<string, ZoneState>>;
  /** Whole-frame motion 0..1. */
  readonly activity: number;
}
export interface VisionAPI {
  cameras(): string[];
  video(src: string | { param: string }): HTMLVideoElement | null;
  mirrored(src: string | { param: string }): boolean;
  /** Subscribe to CV results; models only run while something is subscribed. */
  track(src: string | { param: string }, opts: TrackOpts): VisionHandle;
}

/* ------------------------------------------------------------------- sensors */

export interface SensorChannel {
  readonly name: string;
  readonly unit: string;
  /** Latest raw value in its unit (NaN if none or invalid). */
  readonly raw: number;
  /** Calibrated, smoothed, normalized 0..1. */
  readonly value: number;
  /** A valid sample arrived within the timeout. */
  readonly present: boolean;
  readonly ageMs: number;
  /** Every sample since the last frame. */
  readonly samples: readonly { t: number; raw: number }[];
}
export interface SensorAPI {
  readonly connected: boolean;
  channels(): string[];
  get(src: string | { param: string }): SensorChannel;
  on(name: string, cb: (raw: number, tMs: number) => void): Unsub;
}

/* ----------------------------------------------------------------------- app */

export interface PresetsAPI {
  list(): string[];
  save(name: string): void;
  recall(name: string): void;
  remove(name: string): void;
}

export interface Frame {
  /** Seconds since this app mounted. */
  readonly t: number;
  /** Seconds since the last frame (clamped to ≤ 1/15). */
  readonly dt: number;
  readonly frame: number;
  /** performance.now() at this tick. */
  readonly now: number;
  readonly clock: ClockSnapshot;
  /** Every MIDI event since the last frame. */
  readonly midi: readonly MidiEvent[];
  /** Did this trigger param fire since the last frame? */
  fired(trigger: string): boolean;
}

export interface AppContext<S extends ParamSchema, K extends SurfaceKind> {
  readonly surface: Surface<K>;
  readonly params: Params<S>;
  readonly presets: PresetsAPI;
  readonly audio: AudioAPI;
  readonly midi: MidiAPI;
  readonly vision: VisionAPI;
  readonly sensors: SensorAPI;
  readonly clock: ClockAPI;
  /** Register something to dispose when the app unmounts. */
  own<T extends { dispose(): void } | (() => void)>(x: T): T;
  /** Log to the control window's log panel. */
  log(...args: unknown[]): void;
}

export interface AppInstance {
  frame(f: Frame): void;
  /** The surface was resized (device pixels). */
  resize?(width: number, height: number): void;
  dispose?(): void;
}

export interface AppDef<S extends ParamSchema = ParamSchema, K extends SurfaceKind = SurfaceKind> {
  /** Stable id; used for saved settings. */
  id: string;
  name: string;
  description: string;
  surface: K;
  params: S;
  setup(ctx: AppContext<S, K>): AppInstance | Promise<AppInstance>;
}
