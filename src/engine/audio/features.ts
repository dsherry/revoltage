import { PitchDetector } from 'pitchy';
import type { AudioFeatures } from '@sdk';

const BAND_EDGES_HZ = [40, 80, 160, 320, 640, 1280, 2560, 5120, 16000]; // 8 log-spaced bands
const DB_FLOOR = -90;
const DB_CEIL = -20;
const AUTO_DECAY_S = 3;
const AUTO_FLOOR = 0.05;
const ONSET_HISTORY = 30; // frames (~0.5 s at 60 fps)
const ONSET_REFRACTORY_MS = 100;
/** An onset also needs flux this many times the recent average (rejects sustained-note wobble). */
const ONSET_MIN_RATIO = 1.6;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const dbTo01 = (db: number) => clamp01((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR));

/** Per-frame analysis of one AnalyserNode: levels, bands, adaptive values, centroid, onsets, pitch. */
export class FeatureExtractor implements AudioFeatures {
  rms = 0;
  peak = 0;
  db = -Infinity;
  level = 0;
  readonly bands = new Float32Array(8);
  bass = 0;
  mid = 0;
  treble = 0;
  bassAuto = 0;
  midAuto = 0;
  trebleAuto = 0;
  levelAuto = 0;
  centroid = 0;
  flux = 0;
  onset = false;
  onsetStrength = 0;
  readonly spectrum: Float32Array<ArrayBuffer>;
  readonly waveform: Float32Array<ArrayBuffer>;
  /** Onset threshold = mean + k·σ of recent flux. */
  onsetK = 1.5;

  private mags: Float32Array;
  private prevMags: Float32Array;
  private fluxHist = new Float32Array(ONSET_HISTORY);
  private fluxI = 0;
  private lastOnset = 0;
  private maxes = { bass: AUTO_FLOOR, mid: AUTO_FLOOR, treble: AUTO_FLOOR, level: AUTO_FLOOR };
  private detector: PitchDetector<Float32Array> | null = null;
  private binHz: number;
  private bandBins: [number, number][];
  private bassBins: [number, number];
  private midBins: [number, number];
  private trebleBins: [number, number];

  constructor(private analyser: AnalyserNode) {
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    const n = analyser.frequencyBinCount;
    this.spectrum = new Float32Array(n);
    this.waveform = new Float32Array(analyser.fftSize);
    this.mags = new Float32Array(n);
    this.prevMags = new Float32Array(n);
    this.binHz = analyser.context.sampleRate / analyser.fftSize;
    const bin = (hz: number) => Math.min(n - 1, Math.max(1, Math.round(hz / this.binHz)));
    const range = (lo: number, hi: number): [number, number] => [bin(lo), Math.max(bin(lo) + 1, bin(hi))];
    this.bandBins = BAND_EDGES_HZ.slice(0, -1).map((lo, i) => range(lo, BAND_EDGES_HZ[i + 1]));
    this.bassBins = range(20, 150);
    this.midBins = range(150, 2000);
    this.trebleBins = range(2000, 16000);
  }

  update(now: number, dt: number): void {
    const { spectrum, waveform, mags, prevMags } = this;
    this.analyser.getFloatFrequencyData(spectrum);
    this.analyser.getFloatTimeDomainData(waveform);

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < waveform.length; i++) {
      const v = waveform[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    this.rms = Math.sqrt(sum / waveform.length);
    this.peak = peak;
    this.db = 20 * Math.log10(this.rms || 1e-9);
    this.level = clamp01((this.db + 60) / 60);

    let flux = 0;
    let num = 0;
    let den = 0;
    for (let i = 1; i < spectrum.length; i++) {
      const m = Math.pow(10, spectrum[i] / 20);
      mags[i] = m;
      const d = m - prevMags[i];
      if (d > 0) flux += d;
      num += i * this.binHz * m;
      den += m;
    }
    prevMags.set(mags);
    this.centroid = den > 0 ? num / den : 0;

    for (let b = 0; b < this.bandBins.length; b++) this.bands[b] = this.avgDb01(this.bandBins[b]);
    this.bass = this.avgDb01(this.bassBins);
    this.mid = this.avgDb01(this.midBins);
    this.treble = this.avgDb01(this.trebleBins);

    const decay = Math.exp(-dt / AUTO_DECAY_S);
    const auto = (key: keyof typeof this.maxes, v: number) => {
      this.maxes[key] = Math.max(v, this.maxes[key] * decay, AUTO_FLOOR);
      return v / this.maxes[key];
    };
    this.bassAuto = auto('bass', this.bass);
    this.midAuto = auto('mid', this.mid);
    this.trebleAuto = auto('treble', this.treble);
    this.levelAuto = auto('level', this.level);

    // Onsets: spectral flux above an adaptive threshold, with a refractory period.
    let mean = 0;
    for (const f of this.fluxHist) mean += f;
    mean /= ONSET_HISTORY;
    let variance = 0;
    for (const f of this.fluxHist) variance += (f - mean) ** 2;
    const threshold = Math.max(mean + this.onsetK * Math.sqrt(variance / ONSET_HISTORY), mean * ONSET_MIN_RATIO);
    this.flux = flux;
    this.onset = flux > threshold && flux > 1e-3 && now - this.lastOnset > ONSET_REFRACTORY_MS;
    if (this.onset) this.lastOnset = now;
    this.onsetStrength = this.onset ? clamp01((flux - threshold) / (threshold || 1)) : 0;
    this.fluxHist[this.fluxI] = flux;
    this.fluxI = (this.fluxI + 1) % ONSET_HISTORY;
  }

  pitch(): { hz: number; clarity: number } | null {
    this.detector ??= PitchDetector.forFloat32Array(this.waveform.length);
    const [hz, clarity] = this.detector.findPitch(this.waveform, this.analyser.context.sampleRate);
    return clarity > 0 && hz > 0 ? { hz, clarity } : null;
  }

  private avgDb01([lo, hi]: [number, number]): number {
    let s = 0;
    for (let i = lo; i < hi; i++) s += this.spectrum[i];
    return dbTo01(s / (hi - lo));
  }
}
