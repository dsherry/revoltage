import type {
  AudioAPI, ClockAPI, ClockSnapshot, InputKind, MidiAPI, MidiEvent, SensorAPI, VisionAPI,
} from '@sdk';
import type { Scope } from './scope';

/** What services need from the mounting app's params (to follow `{ param: 'x' }` sources). */
export interface ParamReader {
  get(key: string): unknown;
  on(key: string, cb: (v: unknown) => void): () => void;
}

export interface Service {
  /** Called once from the Start click (inside the user gesture). */
  start(): Promise<void>;
  beginFrame?(now: number, dt: number): void;
  endFrame?(now: number): void;
  /** Device names for `input` param pickers. */
  names?(kind: InputKind): string[];
}

export interface AudioService extends Service {
  /** App-facing API; everything acquired through it is released via `scope`. */
  scoped(scope: Scope, params: ParamReader): AudioAPI;
  fadeAppOut(ms: number): Promise<void>;
  resetAppBus(): void;
  setPanic(on: boolean): void;
}

export interface MidiService extends Service {
  scoped(scope: Scope, params: ParamReader): MidiAPI;
  /** Events received since the last call (once per frame). */
  drain(): readonly MidiEvent[];
  allNotesOff(): void;
  /** Clear app-owned state (LED layer etc.) after an app unmounts. */
  appUnmounted(): void;
}

export interface VisionService extends Service {
  scoped(scope: Scope, params: ParamReader): VisionAPI;
}

export interface SensorService extends Service {
  scoped(scope: Scope, params: ParamReader): SensorAPI;
}

export interface ClockService extends Service {
  scoped(scope: Scope): ClockAPI;
  snapshot(): ClockSnapshot;
}

export interface Services {
  audio: AudioService;
  midi: MidiService;
  sensors: SensorService;
  vision: VisionService;
  clock: ClockService;
}

/** Resolve a device reference: a name, or the current value of an `input` param. */
export function resolveSource(src: string | { param: string }, params: ParamReader): string {
  return typeof src === 'string' ? src : String(params.get(src.param) ?? '');
}
