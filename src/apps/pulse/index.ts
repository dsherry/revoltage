import { clamp, defineApp, defineParams, hexToRgb01, hsvToRgb, mapRange, smoother, type ApcColor } from '@sdk';
import { fullscreenShader, pingPong } from '@sdk/gl';
import { PRESENT_FRAG, PULSE_FRAG } from './shaders';

const MODES = ['warp', 'kaleido', 'tunnel'] as const;

const params = defineParams({
  source: { type: 'input', kind: 'audioIn', default: 'op1', description: 'Audio input that drives the visuals' },
  mode: { type: 'select', options: MODES, default: 'warp', description: 'Pattern mode (APC pad row 7, pads 1–3)' },
  colorA: { type: 'color', default: '#ff2a6d', description: 'Main color (APC palette pads)', group: 'Color' },
  colorB: { type: 'color', default: '#05d9e8', description: 'Second color (Shift + palette pad)', group: 'Color' },
  colorC: { type: 'color', default: '#d1f7ff', description: 'Highlight color for rings and onsets', group: 'Color' },
  hueDrift: { type: 'slider', min: 0, max: 1, default: 0.2, description: 'How much brightness of the sound shifts hue (fader 6)', group: 'Color' },
  intensity: { type: 'slider', min: 0, max: 2, default: 1, description: 'Overall brightness (fader 1)' },
  speed: { type: 'slider', min: 0, max: 3, default: 1, description: 'Animation speed (fader 2)' },
  zoom: { type: 'slider', min: 0.3, max: 3, default: 1, description: 'Pattern scale (fader 3)' },
  warp: { type: 'slider', min: 0, max: 2, default: 1, description: 'Domain warp amount (fader 4)' },
  feedback: { type: 'slider', min: 0, max: 0.98, default: 0.85, description: 'Trail length (fader 5)' },
  bassSens: { type: 'slider', min: 0, max: 3, default: 1, description: 'Bass → zoom pulse (fader 7)', group: 'Reactivity' },
  onsetSens: { type: 'slider', min: 0, max: 3, default: 1, description: 'Onset → flash strength (fader 8)', group: 'Reactivity' },
  smoothing: { type: 'slider', min: 0, max: 1, default: 0.35, description: 'Smooths the response to audio: higher is calmer, lower is snappier', group: 'Reactivity' },
  beatSync: { type: 'toggle', default: false, description: 'Pulse with the clock beat (APC pad row 7, pad 8)', group: 'Reactivity' },
  center: { type: 'xy', default: { x: 0.5, y: 0.5 }, min: 0, max: 1, description: 'Center of the pattern and feedback zoom' },
  flash: { type: 'trigger', description: 'White flash (APC track button 1)' },
});

const FADER_PARAMS = ['intensity', 'speed', 'zoom', 'warp', 'feedback', 'hueDrift', 'bassSens', 'onsetSens'] as const;

// 48 palette pads (APC rows 1–6): a hue sweep, with the last pad white.
const PALETTE = Array.from({ length: 48 }, (_, i) => {
  if (i === 47) return '#ffffff';
  const [r, g, b] = hsvToRgb(i / 47, 0.85, 1);
  return '#' + [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
});

const presetName = (x: number) => `pad ${x + 1}`;

export default defineApp({
  id: 'pulse',
  name: 'Pulse',
  description: 'Audio-reactive feedback shader driven by the OP-1 (or any input). APC faders and pads control it.',
  surface: 'webgl2',
  params,
  setup(ctx) {
    const { gl } = ctx.surface;
    const pattern = ctx.own(fullscreenShader(gl, PULSE_FRAG));
    const present = ctx.own(fullscreenShader(gl, PRESENT_FRAG));
    const fb = ctx.own(pingPong(gl, ctx.surface.width, ctx.surface.height));
    const audio = ctx.audio.input({ param: 'source' });
    const distL = ctx.sensors.get('distL');
    const distR = ctx.sensors.get('distR');
    const apc = ctx.midi.apc;
    const p = ctx.params;

    const bass = smoother(0.1), mid = smoother(0.1), treble = smoother(0.1), level = smoother(0.1), onset = smoother(0.02);
    let phase = 0, hue = 0, onsetEnv = 0, flash = 0;
    let activePreset = -1;

    // --- APC mini: LEDs mirror the current state.
    const leds = () => {
      if (!apc) return;
      const selA = PALETTE.indexOf(p.colorA), selB = PALETTE.indexOf(p.colorB);
      const saved = new Set(ctx.presets.list());
      apc.fill((x, y): ApcColor | null => {
        if (y <= 5) {
          const i = y * 8 + x;
          return i === selA ? 'green' : i === selB ? 'red' : null;
        }
        if (y === 6) {
          if (x < MODES.length) return MODES[x] === p.mode ? 'yellow' : null;
          return x === 7 && p.beatSync ? 'green' : null;
        }
        return x === activePreset ? 'green' : saved.has(presetName(x)) ? 'yellow' : null;
      });
    };

    if (apc) {
      apc.on('fader', (i, v) => {
        const key = FADER_PARAMS[i];
        if (key) ctx.params.set(key, params[key].min + v * (params[key].max - params[key].min));
      });
      apc.on('pad', (x, y, down) => {
        if (!down) return;
        if (y <= 5) {
          ctx.params.set(apc.shift ? 'colorB' : 'colorA', PALETTE[y * 8 + x]);
        } else if (y === 6) {
          if (x < MODES.length) ctx.params.set('mode', MODES[x]);
          else if (x === 7) ctx.params.set('beatSync', !p.beatSync);
        } else if (apc.shift) {
          ctx.presets.save(presetName(x));
          activePreset = x;
        } else if (ctx.presets.list().includes(presetName(x))) {
          ctx.presets.recall(presetName(x));
          activePreset = x;
        }
        leds();
      });
      apc.on('track', (i, down) => { if (down && i === 0) ctx.params.fire('flash'); });
      for (const key of ['colorA', 'colorB', 'mode', 'beatSync'] as const) ctx.params.on(key, leds);
      leds();
    }

    return {
      frame(f) {
        const a = audio.features;
        const dt = f.dt;
        // Smoothing slows both how fast the visuals follow the audio and how fast onset flashes fade.
        const tau = 0.03 + p.smoothing * 0.6;
        bass.update(clamp(a.bassAuto * p.bassSens, 0, 2), dt, tau);
        mid.update(a.midAuto, dt, tau);
        treble.update(a.trebleAuto, dt, tau);
        level.update(a.levelAuto, dt, tau);
        if (a.onset) onsetEnv = Math.max(onsetEnv, 0.4 + 0.6 * a.onsetStrength);
        onsetEnv *= Math.exp(-dt * 8 * (1 - 0.7 * p.smoothing));
        onset.update(onsetEnv, dt, 0.01 + p.smoothing * 0.08);
        if (f.fired('flash')) flash = 1;
        flash *= Math.exp(-dt * 5);

        phase += dt * p.speed * (0.5 + level.value);
        hue = (hue + dt * p.hueDrift * 0.02) % 1;
        const hueOffset = hue + mapRange(a.centroid, 500, 5000, 0, 0.15) * p.hueDrift;
        const beat = p.beatSync && f.clock.playing ? Math.pow(1 - f.clock.phase, 3) : 0;
        const zoom = p.zoom * (distL.present ? 1 + (1 - distL.value) * 0.8 : 1);
        const warp = p.warp + (distR.present ? (1 - distR.value) * 1.5 : 0);

        pattern.draw({
          uPrev: fb.readTexture,
          uRes: [ctx.surface.width, ctx.surface.height],
          uCenter: [p.center.x, 1 - p.center.y],
          uTime: phase,
          uMode: MODES.indexOf(p.mode),
          uColA: hexToRgb01(p.colorA),
          uColB: hexToRgb01(p.colorB),
          uColC: hexToRgb01(p.colorC),
          uIntensity: p.intensity,
          uZoom: zoom,
          uWarp: warp,
          uFeedback: p.feedback,
          uHue: hueOffset,
          uBass: bass.value,
          uMid: mid.value,
          uTreble: treble.value,
          uLevel: level.value,
          uOnset: onset.value * p.onsetSens,
          uBeat: beat,
        }, fb.write);
        fb.swap();
        present.draw({ uTex: fb.readTexture, uFlash: flash });
      },
      resize(w, h) {
        fb.resize(w, h);
      },
    };
  },
});
