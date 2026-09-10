import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { APC_PALETTE, apcColorPad, clamp, defineApp, defineParams, smoother, type ApcColor, type VisionHandle } from '@sdk';
import type { ForestInputs, ForestScene, SceneFactory } from './types';
import { createCanopy } from './canopy';
import { createChloroplast, createShinyCell } from './chloroplast';
import { createLightning } from './lightning';
import { createLightningChase } from './lightning-chase';

const SCENES = ['canopy', 'chloroplast', 'lightning', 'lightning-chase', 'shiny-cell'] as const;
type SceneName = (typeof SCENES)[number];
const FACTORIES: Record<SceneName, SceneFactory> = {
  canopy: createCanopy,
  chloroplast: createChloroplast,
  lightning: createLightning,
  'lightning-chase': createLightningChase,
  'shiny-cell': createShinyCell,
};
const FADERS = 'APC faders 1–8';

// The settings page lists params in this order, so the APC faders come first, in fader order.
const params = defineParams({
  intensity: { type: 'slider', min: 0, max: 2, default: 1, description: 'Overall brightness (fader 1)', group: FADERS },
  speed: { type: 'slider', min: 0, max: 3, default: 1, description: 'How fast things grow, flow and drift (fader 2)', group: FADERS },
  density: { type: 'slider', min: 0, max: 1, default: 0.6, description: 'How many trees, cells or pines (fader 3)', group: FADERS },
  glow: { type: 'slider', min: 0, max: 3, default: 1.2, description: 'Bloom glow strength (fader 4)', group: FADERS },
  calm: { type: 'slider', min: 0, max: 1, default: 0.5, description: 'Smooths the response to audio: higher is more meditative (fader 5)', group: FADERS },
  charge: { type: 'slider', min: 0, max: 1, default: 0.6, description: 'Electricity: how many pulses, sparks or bolts each note makes (fader 6)', group: FADERS },
  light: { type: 'slider', min: 0, max: 1, default: 0.6, description: 'Sun, light shafts and sky brightness (fader 7)', group: FADERS },
  life: { type: 'slider', min: 0, max: 1, default: 0.5, description: 'Fireflies and particles (fader 8)', group: FADERS },
  scene: { type: 'select', options: SCENES, default: 'canopy', description: 'Canopy Current, Chloroplast Flow, Lightning Forest, Lightning Chase (wolves chased by huge penguins on each strike) or Shiny Cell (APC pad row 2, pads 1–5)' },
  colorA: { type: 'color', default: '#3ddc84', description: 'Life: leaves, chloroplasts, forest tint (APC pad rows 3–4)' },
  colorB: { type: 'color', default: '#ffc94d', description: 'Light: sunlit leaves, cell walls, fireflies (APC pad rows 5–6)' },
  colorC: { type: 'color', default: '#7fd4ff', description: 'Electric: pulses, electron sparks, lightning (APC pad rows 7–8)' },
  strike: { type: 'trigger', description: 'Force an electrical strike (APC track button 1)' },
  sensitivity: { type: 'slider', min: 0, max: 1, default: 0.8, description: 'Input sensitivity: 0 = only very loud sound gets through, 1 = everything, even quiet sounds' },
  churn: { type: 'slider', min: 0, max: 1, default: 0.4, description: 'Shiny Cell: how often cells are born and die (hits can spawn cells too)' },
  parade: { type: 'toggle', default: false, description: 'Lightning Chase: each chase is followed by a turtle and a sloth parading with colorful flags' },
  useCamera: {
    type: 'select', options: ['off', 'hand', 'body'], default: 'off',
    description: 'Camera input, applies when the app reloads: hand = your hand moves the sun and fireflies; body = also your silhouette (heavier)',
  },
  camera: { type: 'input', kind: 'camera', default: 'webcam', description: 'Camera for hand / body input' },
  source: { type: 'input', kind: 'audioIn', default: 'op1', description: 'Audio input' },
});

const FADER_PARAMS = ['intensity', 'speed', 'density', 'glow', 'calm', 'charge', 'light', 'life'] as const;
const COLOR_KEYS = ['colorA', 'colorB', 'colorC'] as const;
const presetName = (x: number) => `pad ${x + 1}`;

export default defineApp({
  id: 'forest',
  name: 'Forest',
  description: 'Three meditative, electric forest scenes: Canopy Current, Chloroplast Flow and Lightning Forest.',
  surface: 'three',
  params,
  setup(ctx) {
    const { renderer } = ctx.surface;
    const p = ctx.params;
    const audio = ctx.audio.input({ param: 'source' });
    const apc = ctx.midi.apc;

    // Bloom makes everything bright (pulses, fireflies, sunlit leaves) glow.
    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(1);
    composer.setSize(ctx.surface.width, ctx.surface.height);
    const renderPass = new RenderPass(new THREE.Scene(), new THREE.Camera());
    const bloom = new UnrealBloomPass(new THREE.Vector2(ctx.surface.width, ctx.surface.height), p.glow, 0.6, 0.15);
    composer.addPass(renderPass);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    ctx.own(() => { bloom.dispose(); composer.dispose(); });

    // Scenes are created the first time they're shown and kept, so switching is instant.
    const scenes = new Map<SceneName, ForestScene>();
    const sceneFor = (name: SceneName): ForestScene => {
      let s = scenes.get(name);
      if (!s) {
        s = FACTORIES[name]({ renderer, width: ctx.surface.width, height: ctx.surface.height });
        scenes.set(name, s);
      }
      return s;
    };
    ctx.own(() => { for (const s of scenes.values()) s.dispose(); });
    // A scene that throws renders black (and logs every 2 s) instead of suspending the whole app.
    const blank = { scene: new THREE.Scene(), camera: new THREE.Camera() };
    const lastFailLog = new Map<SceneName, number>();

    let cv: VisionHandle | null = null;
    if (p.useCamera !== 'off') {
      cv = ctx.vision.track({ param: 'camera' }, p.useCamera === 'body'
        ? { pose: { maxPeople: 1 }, hands: true, mask: true }
        : { hands: true });
    }
    const maskTex = ctx.own(new THREE.Texture());
    maskTex.flipY = false;
    let maskAt = 0;

    const inputs: ForestInputs = {
      t: 0, dt: 0, realDt: 0, level: 0, bass: 0, mid: 0, treble: 0,
      onset: false, onsetStrength: 0, pitch: null, beat: 0, hand: null, mask: null, maskMirrored: false,
      colorA: new THREE.Color(), colorB: new THREE.Color(), colorC: new THREE.Color(),
      intensity: 1, density: 0.6, charge: 0.6, light: 0.6, life: 0.5, parade: false, churn: 0.4,
    };
    const level = smoother(0.2), bass = smoother(0.2), mid = smoother(0.2), treble = smoother(0.2);
    const handX = smoother(0.15, 0.5), handY = smoother(0.15, 0.5);
    const gate = smoother(0.1);
    const handPos = { x: 0.5, y: 0.5 };
    let glowBoost = 0;
    let activePreset = -1;

    // --- APC mini: faders 1–8, row 2 = scenes, rows 3–8 = colors, top row = presets, track 1 = strike.
    const leds = () => {
      if (!apc) return;
      const saved = new Set(ctx.presets.list());
      apc.fill((x, y): ApcColor | null => {
        const c = apcColorPad(x, y);
        if (c) return APC_PALETTE.indexOf(p[COLOR_KEYS[c.slot]]) === c.index ? c.led : null;
        if (y === 6) return x < SCENES.length && SCENES[x] === p.scene ? 'yellow' : null;
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
        const c = apcColorPad(x, y);
        if (c) {
          ctx.params.set(COLOR_KEYS[c.slot], APC_PALETTE[c.index]);
        } else if (y === 6) {
          if (x < SCENES.length) ctx.params.set('scene', SCENES[x]);
        } else if (apc.shift) {
          ctx.presets.save(presetName(x));
          activePreset = x;
        } else if (ctx.presets.list().includes(presetName(x))) {
          ctx.presets.recall(presetName(x));
          activePreset = x;
        }
        leds();
      });
      apc.on('track', (i, down) => { if (down && i === 0) ctx.params.fire('strike'); });
      for (const key of [...COLOR_KEYS, 'scene'] as const) ctx.params.on(key, leds);
      leds();
    }

    return {
      frame(f) {
        const a = audio.features;
        // Sensitivity is a soft noise gate on the real input level (the *Auto values are
        // loudness-normalized, so they can't tell quiet from loud). 1 = always open.
        const threshold = (1 - p.sensitivity) * 0.9;
        const open = clamp((a.level - threshold + 0.06) / 0.12, 0, 1);
        const g = gate.update(open * open * (3 - 2 * open), f.dt);
        const tau = 0.05 + p.calm * 0.9;
        inputs.level = level.update(a.levelAuto * g, f.dt, tau);
        inputs.bass = bass.update(a.bassAuto * g, f.dt, tau);
        inputs.mid = mid.update(a.midAuto * g, f.dt, tau);
        inputs.treble = treble.update(a.trebleAuto * g, f.dt, tau);

        const strike = f.fired('strike');
        inputs.onset = strike || (a.onset && g > 0.5 && p.charge > 0.02);
        inputs.onsetStrength = strike ? 1 : a.onsetStrength;
        inputs.pitch = null;
        if (a.onset) {
          const pitch = a.pitch();
          if (pitch && pitch.clarity > 0.8) inputs.pitch = clamp(Math.log2(pitch.hz / 65.41) / 5, 0, 1);
        }
        inputs.beat = f.clock.playing ? Math.pow(1 - f.clock.phase, 3) : 0;
        inputs.realDt = f.dt;
        inputs.dt = f.dt * p.speed;
        inputs.t += inputs.dt;

        inputs.hand = null;
        if (cv) {
          const pt = cv.hands[0]?.landmarks[9] ?? cv.people[0]?.center;
          if (pt) {
            handPos.x = handX.update(pt.x, f.dt);
            handPos.y = handY.update(pt.y, f.dt);
            inputs.hand = handPos;
          }
          if (cv.mask && cv.updatedAt !== maskAt) {
            maskAt = cv.updatedAt;
            maskTex.image = cv.mask.bitmap;
            maskTex.needsUpdate = true;
          }
          inputs.mask = cv.mask ? maskTex : null;
          inputs.maskMirrored = ctx.vision.mirrored({ param: 'camera' });
        }

        inputs.colorA.set(p.colorA);
        inputs.colorB.set(p.colorB);
        inputs.colorC.set(p.colorC);
        inputs.intensity = p.intensity;
        inputs.density = p.density;
        inputs.charge = p.charge;
        inputs.light = p.light;
        inputs.life = p.life;
        inputs.parade = p.parade;
        inputs.churn = p.churn;

        let scene: { scene: THREE.Scene; camera: THREE.Camera } = blank;
        try {
          const s = sceneFor(p.scene);
          s.update(inputs);
          scene = s;
        } catch (e) {
          if (f.now - (lastFailLog.get(p.scene) ?? -Infinity) > 2000) {
            lastFailLog.set(p.scene, f.now);
            ctx.log(`⚠ scene "${p.scene}" failed; showing black. Switch scenes with APC row 2.`, e);
          }
        }

        glowBoost = Math.max(glowBoost * Math.exp(-f.dt * 6), inputs.onset ? 0.5 * inputs.onsetStrength : 0);
        bloom.strength = p.glow * (1 + glowBoost);
        renderPass.scene = scene.scene;
        renderPass.camera = scene.camera;
        composer.render(f.dt);
      },
      resize(w, h) {
        composer.setSize(w, h);
        for (const s of scenes.values()) s.resize(w, h);
      },
    };
  },
});
