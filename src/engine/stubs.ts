// Placeholder services that report everything as offline, so apps run before
// the real audio / MIDI / vision / sensor / clock services land.
import type {
  AudioAPI, AudioFeatures, ClockAPI, ClockSnapshot, MidiAPI, MidiInHandle, MidiOutHandle,
  SensorAPI, VisionAPI, VisionHandle,
} from '@sdk';
import type {
  AudioService, ClockService, MidiService, ParamReader, SensorService, Services, VisionService,
} from './services';
import { resolveSource } from './services';
import type { Scope } from './scope';

const notYet = (what: string): never => { throw new Error(`${what} is not implemented yet`); };

export function zeroFeatures(): AudioFeatures {
  return {
    rms: 0, peak: 0, db: -Infinity, level: 0, bands: new Float32Array(8),
    bass: 0, mid: 0, treble: 0, bassAuto: 0, midAuto: 0, trebleAuto: 0, levelAuto: 0,
    centroid: 0, flux: 0, onset: false, onsetStrength: 0,
    spectrum: new Float32Array(1024), waveform: new Float32Array(2048), pitch: () => null,
  };
}

export class StubAudio implements AudioService {
  async start(): Promise<void> {}
  scoped(_scope: Scope, params: ParamReader): AudioAPI {
    const features = zeroFeatures();
    return {
      get ctx(): AudioContext { return notYet('audio'); },
      get out(): AudioNode { return notYet('audio'); },
      input: (src) => ({
        alias: resolveSource(src, params), connected: false, features,
        get node(): AudioNode { return notYet('audio'); },
        setMonitor() {},
      }),
      master: { features },
      recorder: () => notYet('audio recorder'),
    };
  }
  async fadeAppOut(): Promise<void> {}
  resetAppBus(): void {}
  setPanic(): void {}
}

const offIn: MidiInHandle = { connected: false, on: () => () => {}, cc: () => 0, held: () => new Set() };
const offOut: MidiOutHandle = { connected: false, noteOn() {}, noteOff() {}, cc() {}, send() {}, allNotesOff() {} };

export class StubMidi implements MidiService {
  async start(): Promise<void> {}
  scoped(): MidiAPI { return { input: () => offIn, output: () => offOut, apc: null, op1: null }; }
  drain() { return []; }
  allNotesOff(): void {}
  appUnmounted(): void {}
}

const emptyVision: VisionHandle = {
  connected: false, fps: 0, latencyMs: 0, updatedAt: 0, people: [], hands: [], mask: null, zones: {}, activity: 0,
};

export class StubVision implements VisionService {
  async start(): Promise<void> {}
  scoped(): VisionAPI {
    return { cameras: () => [], video: () => null, mirrored: () => false, track: () => emptyVision };
  }
}

export class StubSensors implements SensorService {
  async start(): Promise<void> {}
  scoped(_scope: Scope, params: ParamReader): SensorAPI {
    return {
      connected: false,
      channels: () => [],
      get: (src) => ({ name: resolveSource(src, params), unit: '', raw: NaN, value: 0, present: false, ageMs: Infinity, samples: [] }),
      on: () => () => {},
    };
  }
}

const idleClock: ClockSnapshot = { source: 'internal', bpm: 120, playing: false, beats: 0, bar: 0, beatInBar: 0, phase: 0 };

export class StubClock implements ClockService {
  async start(): Promise<void> {}
  snapshot(): ClockSnapshot { return idleClock; }
  scoped(): ClockAPI {
    return { ...idleClock, on: () => () => {}, get transport(): ClockAPI['transport'] { return notYet('clock transport'); } };
  }
}

export function createStubServices(): Services {
  return { audio: new StubAudio(), midi: new StubMidi(), sensors: new StubSensors(), vision: new StubVision(), clock: new StubClock() };
}
