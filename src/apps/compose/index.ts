import * as Tone from 'tone';
import { clamp, defineApp, defineParams, mapRange } from '@sdk';
import { GestureTracker, MIN_SIZE, type HandState, type Swing } from './gestures';
import { makeNotes, NOTE_NAMES, noteName, randInt, SCALE_NAMES, SCALES } from './scales';

const OUTPUTS = ['OP-1 (MIDI)', 'Browser synth'] as const;
const KEY_STYLES = ['root', 'random', 'height'] as const;

const TEMPO = 'Tempo';
const DEVICES = 'Devices';

/** Swing size (body scales) that plays the longest string. */
const BIG_SIZE = 2.5;
/** Notes are sent this far ahead; kept short because sent MIDI can't be recalled. */
const LOOKAHEAD_MS = 50;
/** Held fraction of each step. */
const GATE = 0.8;
/** OP-1 notes come back as audio about this much later. */
const OP1_LATENCY_S = 0.03;
/** An OP-1 string's echo keeps listening this long after its last note, for the release. */
const OP1_TAIL_S = 0.3;
const SYNTH_RELEASE_S = 0.25;
const MAX_ECHOES = 16;
/** Repeat note-offs this much later at a stop, for notes already sent ahead. */
const STOP_REPEAT_MS = 250;
const HAND_COLORS: Record<HandState, string> = { open: '#5cffb0', closed: '#ff3b6b', none: '#777' };

const params = defineParams({
  output: { type: 'select', options: OUTPUTS, default: 'OP-1 (MIDI)', description: 'Where the notes go: MIDI to the OP-1, or a synth in the browser' },
  repeat: { type: 'toggle', default: true, description: 'Echo each string: it comes back after its own length plus the same length of silence' },
  feedback: { type: 'slider', min: 0, max: 0.99, step: 0.01, default: 0.25, description: 'How slowly the echoes die away: 0 = one repeat, 0.99 = very slow' },
  scale: { type: 'select', options: SCALE_NAMES, default: SCALE_NAMES[0], description: 'Notes the strings are made of' },
  keyStyle: { type: 'select', options: KEY_STYLES, default: 'root', description: 'Key of each string: the root setting, random, or the height of the swing on screen (12 bands, C at the bottom up to B at the top)' },
  root: { type: 'select', options: NOTE_NAMES, default: 'C', description: 'Key (when key style is root)' },
  octave: { type: 'slider', min: 1, max: 7, step: 1, default: 4, description: 'Octave of the root (4 = middle C)' },
  startOnRoot: { type: 'toggle', default: false, description: 'Up-swings start on the root, down-swings on the root an octave up' },
  minNotes: { type: 'slider', min: 1, max: 12, step: 1, default: 2, description: 'Notes in a string from the smallest swings' },
  maxNotes: { type: 'slider', min: 1, max: 24, step: 1, default: 7, description: 'Notes in a string from the biggest swings (if not above the minimum, the minimum + 1)' },
  slowest: { type: 'slider', min: 0.5, max: 8, step: 0.1, default: 2, group: TEMPO, description: 'Notes per second for the slowest swings' },
  fastest: { type: 'slider', min: 4, max: 30, step: 0.5, default: 16, group: TEMPO, description: 'Notes per second for the fastest swings' },
  minSwing: { type: 'slider', min: 0.5, max: 8, step: 0.1, default: 2, group: TEMPO, description: 'Wrist speed (shoulder widths per second) a movement needs to count as a swing' },
  fastSwing: { type: 'slider', min: 3, max: 25, step: 0.5, default: 10, group: TEMPO, description: 'Wrist speed that plays at the fastest tempo' },
  camera: { type: 'input', kind: 'camera', default: 'webcam', group: DEVICES, description: 'Camera watching the performers' },
  maxPeople: { type: 'slider', min: 1, max: 4, step: 1, default: 2, group: DEVICES, description: 'People to track (applies when the app reloads)' },
  midiOut: { type: 'input', kind: 'midiOut', default: 'op1', group: DEVICES, description: 'MIDI output in OP-1 mode' },
  channel: { type: 'slider', min: 1, max: 16, step: 1, default: 1, group: DEVICES, description: 'MIDI channel' },
  audioIn: { type: 'input', kind: 'audioIn', default: 'op1', group: DEVICES, description: 'Audio input the echo takes in OP-1 mode' },
  debug: { type: 'toggle', default: false, description: 'Show the camera, arms and hand states on the output, for tuning' },
  test: { type: 'trigger', description: 'Play a random string (no camera needed)' },
  stop: { type: 'trigger', description: 'Same as the X pose: all notes off and the echoes cleared' },
});

const mtof = (n: number): number => 440 * 2 ** ((n - 69) / 12);

/** One string's echo: input → delay ⟲ feedback → out. Wet only; the dry sound goes its own way. */
class Echo {
  readonly input: GainNode;
  readonly fb: GainNode;
  private readonly delay: DelayNode;
  private readonly out: GainNode;
  private src: AudioNode | null = null;

  constructor(private readonly ac: AudioContext, dest: AudioNode, readonly time: number, feedback: number, public closeAt: number) {
    this.input = new GainNode(ac);
    this.delay = new DelayNode(ac, { maxDelayTime: time + 0.1, delayTime: time });
    this.fb = new GainNode(ac, { gain: feedback });
    this.out = new GainNode(ac);
    this.input.connect(this.delay).connect(this.out).connect(dest);
    this.delay.connect(this.fb).connect(this.delay);
  }

  /** Take a shared source (the OP-1 input), but only between `openAt` and `closeAt`. */
  listen(src: AudioNode, openAt: number): void {
    this.src = src;
    const g = this.input.gain;
    g.setValueAtTime(0, this.ac.currentTime);
    g.setValueAtTime(0, openAt);
    g.linearRampToValueAtTime(1, openAt + 0.005);
    g.setValueAtTime(1, this.closeAt);
    g.linearRampToValueAtTime(0, this.closeAt + 0.005);
    src.connect(this.input);
  }

  /** A newer string takes over the shared source from `at`. */
  handOver(at: number): void {
    if (!this.src || at >= this.closeAt) return;
    const g = this.input.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(1, at);
    g.linearRampToValueAtTime(0, at + 0.005);
    this.closeAt = at;
  }

  /** When the echoes have died below -60 dB. */
  endAt(feedback: number): number {
    const repeats = feedback > 0.001 ? 1 + Math.log(0.001) / Math.log(feedback) : 1;
    return this.closeAt + this.time * repeats + 0.1;
  }

  /** Fade out, then drop the nodes (and the audio in the delay with them). */
  dispose(fade = 0.005): void {
    const t = this.ac.currentTime, g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + fade);
    this.input.gain.cancelScheduledValues(t);
    this.input.gain.setValueAtTime(0, t);
    window.setTimeout(() => {
      try { this.src?.disconnect(this.input); } catch { /* already gone */ }
      this.input.disconnect();
      this.delay.disconnect();
      this.fb.disconnect();
      this.out.disconnect();
    }, fade * 1000 + 50);
  }
}

interface Str {
  readonly notes: number[];
  /** First note, performance.now() ms and audio-context seconds. */
  readonly t0: number;
  readonly a0: number;
  /** Seconds between notes. */
  readonly step: number;
  readonly vel: number;
  readonly ch: number;
  /** Browser-synth voice; null sends MIDI. */
  readonly voice: Tone.Synth | null;
  next: number;
}

export default defineApp({
  id: 'compose',
  name: 'comPose',
  description: 'Wave open hands to play strings of notes (OP-1 over MIDI or a browser synth) that echo; cross your arms in an X to stop everything.',
  surface: '2d',
  params,
  setup(ctx) {
    const g = ctx.surface.g2d;
    const p = ctx.params;
    const ac = ctx.audio.ctx;
    const cv = ctx.vision.track({ param: 'camera' }, { pose: { maxPeople: p.maxPeople }, hands: { maxHands: p.maxPeople * 2 } });
    const midiOut = ctx.midi.output({ param: 'midiOut' });
    const audioIn = ctx.audio.input({ param: 'audioIn' });
    const gestures = new GestureTracker();

    const strings: Str[] = [];
    const voices: { synth: Tone.Synth; doneAt: number }[] = [];
    let echoes: Echo[] = [];
    /** MIDI notes on (or sent ahead), for the stop. */
    let held: { n: number; ch: number; until: number }[] = [];
    let lastCv = 0;
    let warnedMidi = false;

    const dropEchoes = (fade?: number): void => {
      for (const e of echoes) e.dispose(fade);
      echoes = [];
    };
    ctx.own(p.on('feedback', (v) => { for (const e of echoes) e.fb.gain.setTargetAtTime(v, ac.currentTime, 0.02); }));
    ctx.own(p.on('repeat', (on) => { if (!on) dropEchoes(0.05); }));

    /** MIDI note of this string's root, from the key style. */
    function rootFor(s: Swing): number {
      const key = p.keyStyle === 'random' ? randInt(0, 11)
        : p.keyStyle === 'height' ? clamp(Math.floor((1 - s.y) * 12), 0, 11)
        : Math.max(0, NOTE_NAMES.indexOf(p.root));
      return 12 * (p.octave + 1) + key;
    }

    function play(s: Swing): void {
      const u = clamp((s.speed - p.minSwing) / Math.max(0.1, p.fastSwing - p.minSwing));
      const rate = p.slowest * (Math.max(p.fastest, p.slowest) / p.slowest) ** u;
      const step = 1 / rate;
      const lo = p.minNotes, hi = p.maxNotes > p.minNotes ? p.maxNotes : p.minNotes + 1;
      const count = Math.round(mapRange(s.size, MIN_SIZE, BIG_SIZE, lo, hi));
      const notes = makeNotes(SCALES[p.scale] ?? SCALES[SCALE_NAMES[0]], s.dir, count, rootFor(s), p.startOnRoot);
      if (p.debug) ctx.log(`velocity ${s.speed.toFixed(1)} (${rate.toFixed(1)} notes/s): ${notes.map(noteName).join(' ')}`);
      const len = count * step;
      const synth = p.output === 'Browser synth';
      const t0 = performance.now() + 10, a0 = ac.currentTime + 0.01;

      let voice: Tone.Synth | null = null;
      if (synth) {
        voice = new Tone.Synth({
          oscillator: { type: 'triangle' },
          envelope: { attack: 0.005, decay: 0.15, sustain: 0.3, release: SYNTH_RELEASE_S },
          volume: -8,
        });
        voice.connect(ctx.audio.out);
        voices.push({ synth: voice, doneAt: t0 + (len + SYNTH_RELEASE_S + 0.2) * 1000 });
      } else if (!midiOut.connected && !warnedMidi) {
        warnedMidi = true;
        ctx.log('MIDI output not connected; notes are going nowhere');
      }

      if (p.repeat) {
        const echo = new Echo(ac, ctx.audio.out, 2 * len, p.feedback, a0 + len + (synth ? SYNTH_RELEASE_S : OP1_TAIL_S));
        if (voice) {
          voice.connect(echo.input);
        } else {
          for (const e of echoes) e.handOver(a0 + OP1_LATENCY_S);
          echo.listen(audioIn.node, a0);
        }
        echoes.push(echo);
        while (echoes.length > MAX_ECHOES) echoes.shift()?.dispose(0.05);
      }

      strings.push({ notes, t0, a0, step, vel: 0.6 + 0.4 * u, ch: p.channel, voice, next: 0 });
    }

    function schedule(now: number): void {
      const horizon = now + LOOKAHEAD_MS;
      for (let i = strings.length - 1; i >= 0; i--) {
        const s = strings[i];
        const gate = Math.max(0.02, s.step * GATE);
        while (s.next < s.notes.length && s.t0 + s.next * s.step * 1000 <= horizon) {
          const n = s.notes[s.next];
          if (s.voice) {
            s.voice.triggerAttackRelease(mtof(n), gate, s.a0 + s.next * s.step, s.vel);
          } else {
            const at = s.t0 + s.next * s.step * 1000;
            midiOut.noteOn(n, s.vel, s.ch, at);
            midiOut.noteOff(n, s.ch, at + gate * 1000);
            held.push({ n, ch: s.ch, until: at + gate * 1000 });
          }
          s.next++;
        }
        if (s.next >= s.notes.length) strings.splice(i, 1);
      }
    }

    function housekeeping(now: number): void {
      if (held.length) held = held.filter((h) => h.until > now);
      for (let i = voices.length - 1; i >= 0; i--) {
        if (now < voices[i].doneAt) continue;
        voices[i].synth.dispose();
        voices.splice(i, 1);
      }
      const t = ac.currentTime;
      const done = echoes.filter((e) => t > e.endAt(p.feedback));
      if (done.length) {
        for (const e of done) e.dispose();
        echoes = echoes.filter((e) => !done.includes(e));
      }
      if (midiOut.connected) warnedMidi = false;
    }

    /** Instant silence: pending notes dropped, MIDI panic, synth voices cut, echoes cleared. */
    function stopAll(why: string): void {
      strings.length = 0;
      for (const v of voices) v.synth.dispose();
      voices.length = 0;
      dropEchoes();
      const later = performance.now() + STOP_REPEAT_MS;
      for (const h of held) {
        midiOut.noteOff(h.n, h.ch);
        midiOut.noteOff(h.n, h.ch, later);
      }
      held = [];
      midiOut.allNotesOff();
      gestures.cancel();
      ctx.log(`${why} — all notes off, echoes cleared`);
    }

    function drawDebug(): void {
      const { width: w, height: h } = ctx.surface;
      const video = ctx.vision.video({ param: 'camera' });
      if (video && video.readyState >= 2) {
        g.save();
        if (ctx.vision.mirrored({ param: 'camera' })) { g.translate(w, 0); g.scale(-1, 1); }
        g.globalAlpha = 0.4;
        g.drawImage(video, 0, 0, w, h);
        g.restore();
      }
      g.lineWidth = Math.max(3, h / 180);
      g.font = `${Math.round(h / 32)}px system-ui`;
      for (const person of cv.people) {
        const body = gestures.bodies.get(person.id);
        const lm = person.landmarks;
        [[11, 13, 15], [12, 14, 16]].forEach((chain, i) => {
          const arm = body?.arms[i];
          g.strokeStyle = HAND_COLORS[arm?.hand ?? 'none'];
          g.beginPath();
          chain.forEach((k, j) => (j ? g.lineTo(lm[k].x * w, lm[k].y * h) : g.moveTo(lm[k].x * w, lm[k].y * h)));
          g.stroke();
          const wr = lm[chain[2]];
          g.fillStyle = '#fff';
          g.fillText(`${arm?.hand ?? '—'} ${(arm?.speed ?? 0).toFixed(1)}`, wr.x * w + 8, wr.y * h - 8);
        });
      }
      g.fillStyle = gestures.x.latched ? '#ff3b6b' : '#9f9';
      g.font = `${Math.round(h / 36)}px ui-monospace, monospace`;
      const src = p.output === 'Browser synth' ? 'synth' : `midi ${midiOut.connected ? 'ok' : 'NOT CONNECTED'}`;
      g.fillText(
        `${cv.connected ? `cv ${cv.fps.toFixed(0)} fps` : 'camera not connected'} · ${src} · strings ${strings.length} · echoes ${echoes.length}${gestures.x.active ? ' · X' : ''}`,
        h / 40, h - h / 40,
      );
    }

    return {
      frame(f) {
        if (f.fired('stop')) stopAll('stop');
        if (f.fired('test')) {
          play({
            dir: Math.random() < 0.5 ? 'up' : 'down',
            speed: mapRange(Math.random(), 0, 1, p.minSwing, p.fastSwing),
            size: mapRange(Math.random(), 0, 1, MIN_SIZE, BIG_SIZE),
            open: true,
            y: Math.random(),
          });
        }
        if (cv.connected && cv.updatedAt !== lastCv) {
          lastCv = cv.updatedAt;
          const r = gestures.update(cv.people, cv.hands, cv.updatedAt, p.minSwing);
          if (r.stop) stopAll('X pose');
          for (const s of r.swings) if (s.open) play(s);
        }
        schedule(f.now);
        housekeeping(f.now);

        const { width: w, height: h } = ctx.surface;
        g.globalAlpha = 1;
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        if (p.debug) drawDebug();
      },
      dispose() {
        strings.length = 0;
        for (const v of voices) v.synth.dispose();
        voices.length = 0;
        dropEchoes();
      },
    };
  },
});
