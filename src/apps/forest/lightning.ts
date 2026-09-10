import * as THREE from 'three';
import type { ForestInputs, SceneFactory } from './types';
import { BoltGeometry, buildPineLayer, GROUND_VERTS, PINE_SPAN, VERTS_PER_TREE, type PineLayerSpec } from './lightning-geometry';
import {
  BOLT_FRAG, BOLT_VERT, FIREFLY_FRAG, FIREFLY_VERT, MASK_FRAG, PINE_FRAG, PINE_VERT, SCREEN_VERT, SKY_FRAG,
} from './lightning-shaders';

interface LayerDef extends PineLayerSpec {
  speed: number;
  fogMix: number;
  rim: number;
  sway: number;
}

// Back to front. Each layer's ground sits lower and its trees are taller, so nearer layers overlap farther ones.
const LAYERS: LayerDef[] = [
  { ground: -0.2, minH: 0.22, maxH: 0.42, maxTrees: 110, seed: 11, speed: 0.006, fogMix: 0.78, rim: 0.15, sway: 0.002 },
  { ground: -0.42, minH: 0.32, maxH: 0.58, maxTrees: 72, seed: 23, speed: 0.013, fogMix: 0.52, rim: 0.35, sway: 0.003 },
  { ground: -0.66, minH: 0.5, maxH: 0.85, maxTrees: 44, seed: 37, speed: 0.026, fogMix: 0.27, rim: 0.7, sway: 0.005 },
  { ground: -0.95, minH: 0.85, maxH: 1.35, maxTrees: 24, seed: 41, speed: 0.05, fogMix: 0, rim: 1, sway: 0.008 },
];

const FIREFLIES_PER_GROUP = 160;
const BOLT_POOL = 6;
// Bolts end below layer 1's ground line, so they vanish into the forest behind it.
const BOLT_END_Y = -0.5;

// Draw order (everything is transparent + depthless so renderOrder alone decides).
const ORDER = { sky: 0, pine0: 1, bolts: 2, pine1: 3, firefliesBack: 4, pine2: 5, mask: 6, firefliesFront: 7, pine3: 8 };
const PINE_ORDER = [ORDER.pine0, ORDER.pine1, ORDER.pine2, ORDER.pine3];

interface Bolt {
  geo: BoltGeometry;
  mat: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  active: boolean;
  age: number;
  life: number;
  strength: number;
  seed: number;
  x: number;
}

const baseMaterial = (blending: THREE.Blending): THREE.ShaderMaterialParameters => ({
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending,
  side: THREE.DoubleSide,
});

export const createLightning: SceneFactory = (ctx) => {
  const scene = new THREE.Scene();
  let aspect = ctx.width / Math.max(1, ctx.height);
  const camera = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, 0.1, 10);
  camera.position.z = 1;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const add = (obj: THREE.Mesh | THREE.Points, order: number) => {
    obj.renderOrder = order;
    obj.frustumCulled = false;
    scene.add(obj);
    geometries.push(obj.geometry);
    materials.push(obj.material as THREE.Material);
    return obj;
  };

  // Uniforms shared by several materials (the same {value} objects, so one write updates all).
  const uTime = { value: 0 };
  const uAspect = { value: aspect };
  const uIntensity = { value: 1 };
  const uFlash = { value: 0 };
  const uFog = { value: new THREE.Color() };
  const uFlashCol = { value: new THREE.Color() };
  const uColB = { value: new THREE.Color() };
  const uColC = { value: new THREE.Color() };
  const uBass = { value: 0 };
  const uTreble = { value: 0 };

  // --- Sky
  const quad = new THREE.PlaneGeometry(2, 2);
  const skyMat = new THREE.ShaderMaterial({
    ...baseMaterial(THREE.NoBlending),
    vertexShader: SCREEN_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uAspect, uTime, uIntensity, uFlash, uFog, uFlashCol, uColB, uBass, uTreble,
      uSky: { value: 1 },
      uMoonLight: { value: 0.6 },
      uFlashX: { value: 0 },
      uMoon: { value: new THREE.Vector2(aspect * 0.52, 0.6) },
    },
  });
  add(new THREE.Mesh(quad, skyMat), ORDER.sky);

  // --- Pine layers
  const uDark = { value: new THREE.Color() };
  const layers = LAYERS.map((def, l) => {
    const geo = buildPineLayer(def);
    const mat = new THREE.ShaderMaterial({
      ...baseMaterial(THREE.NoBlending),
      vertexShader: PINE_VERT,
      fragmentShader: PINE_FRAG,
      uniforms: {
        uTime, uIntensity, uFlash, uFog, uFlashCol, uColC, uDark,
        uScroll: { value: 0 },
        uSpan: { value: PINE_SPAN },
        uSway: { value: def.sway },
        uFogMix: { value: def.fogMix },
        uGround: { value: def.ground },
        uRim: { value: 0 },
      },
    });
    add(new THREE.Mesh(geo, mat), PINE_ORDER[l]);
    // Start each layer at a different offset so the golden-ratio patterns don't line up.
    return { def, geo, mat, scroll: l * 1.37 };
  });

  // --- Fireflies: two groups, one behind pine layer 2 and one in front of it.
  const makeFireflies = (yMin: number, yMax: number, scale: number, gain: number, order: number) => {
    const n = FIREFLIES_PER_GROUP;
    const r1 = new Float32Array(n * 4);
    const r2 = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      r1.set([Math.random(), Math.random(), Math.random(), Math.random()], k * 4);
      r2.set([0.35 + Math.random() * 0.5, 0.6 + Math.random() * 1.4, 7 + Math.random() * 7, 5 + Math.random() * 8], k * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(r1, 4));
    geo.setAttribute('aRand2', new THREE.BufferAttribute(r2, 4));
    const mat = new THREE.ShaderMaterial({
      ...baseMaterial(THREE.AdditiveBlending),
      vertexShader: FIREFLY_VERT,
      fragmentShader: FIREFLY_FRAG,
      uniforms: {
        uTime, uAspect, uIntensity, uColB, uTreble,
        uPx: { value: ctx.height / 1080 },
        uScale: { value: scale },
        uGain: { value: gain },
        uMid: { value: 0 },
        uBeat: { value: 0 },
        uYRange: { value: new THREE.Vector2(yMin, yMax) },
        uHand: { value: new THREE.Vector3() },
      },
    });
    add(new THREE.Points(geo, mat), order);
    return { geo, mat };
  };
  const fireflies = [
    makeFireflies(-0.5, 0.15, 0.8, 0.55, ORDER.firefliesBack),
    makeFireflies(-0.85, 0.05, 1.25, 1, ORDER.firefliesFront),
  ];

  // --- Performer silhouette
  const maskMat = new THREE.ShaderMaterial({
    ...baseMaterial(THREE.CustomBlending),
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    vertexShader: SCREEN_VERT,
    fragmentShader: MASK_FRAG,
    uniforms: {
      uAspect, uTime, uIntensity, uFlash, uColB, uColC,
      uMask: { value: null as THREE.Texture | null },
      uMirrored: { value: 0 },
      uAmount: { value: 0 },
    },
  });
  const maskMesh = add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), maskMat), ORDER.mask);
  maskMesh.visible = false;
  let maskAmount = 0;

  // --- Lightning bolt pool (each bolt has its own small geometry, rewritten only when it spawns).
  const bolts: Bolt[] = [];
  for (let b = 0; b < BOLT_POOL; b++) {
    const geo = new BoltGeometry();
    const mat = new THREE.ShaderMaterial({
      ...baseMaterial(THREE.AdditiveBlending),
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      uniforms: {
        uIntensity, uColC,
        uWidth: { value: 0.024 },
        uFade: { value: 0 },
        uReveal: { value: 0 },
      },
    });
    const mesh = new THREE.Mesh(geo.geometry, mat);
    mesh.visible = false;
    add(mesh, ORDER.bolts);
    bolts.push({ geo, mat, mesh, active: false, age: 0, life: 0.35, strength: 1, seed: 0, x: 0 });
  }

  const spawnBolt = (strength: number, charge: number) => {
    let slot = bolts[0];
    for (const b of bolts) {
      if (!b.active) { slot = b; break; }
      if (b.age / b.life > slot.age / slot.life) slot = b;
    }
    const w = aspect * 0.85;
    const x0 = (Math.random() * 2 - 1) * w;
    const x1 = Math.max(-aspect * 0.9, Math.min(aspect * 0.9, x0 + (Math.random() - 0.5) * 0.9));
    const branches = Math.min(3, 1 + Math.floor(Math.random() * (1 + 2 * charge)));
    slot.geo.generate(x0, 1.08, x1, BOLT_END_Y, branches);
    slot.active = true;
    slot.age = 0;
    slot.life = 0.35 * (0.8 + Math.random() * 0.4);
    slot.strength = 0.6 + 0.4 * strength;
    slot.seed = Math.random();
    slot.x = (x0 + x1) * 0.5;
    slot.mesh.visible = true;
    flashX = slot.x;
  };

  let flash = 0;
  let flashX = 0;
  let handAmount = 0;
  const tint = new THREE.Color();

  const update = (i: ForestInputs) => {
    uTime.value = i.t;
    uIntensity.value = i.intensity;
    uBass.value = i.bass;
    uTreble.value = i.treble;
    uColB.value.copy(i.colorB);
    uColC.value.copy(i.colorC);
    uFlashCol.value.copy(i.colorC).multiplyScalar(0.6).addScalar(0.4);
    const skyB = 0.45 + i.light * 1.1;
    tint.copy(i.colorA).multiplyScalar(0.012);
    uFog.value.setRGB(0.008, 0.011, 0.022).add(tint).multiplyScalar((0.6 + i.light * 0.8) * (1 + 0.3 * i.bass));
    tint.copy(i.colorA).multiplyScalar(0.003);
    uDark.value.setRGB(0.001, 0.0015, 0.0025).add(tint);
    skyMat.uniforms.uSky.value = skyB;
    skyMat.uniforms.uMoonLight.value = i.light;

    // Lightning
    if (i.onset && i.onsetStrength >= (1 - i.charge) * 0.7) {
      const n = Math.min(3, 1 + Math.floor(i.charge * i.charge * i.onsetStrength * 2.5));
      for (let k = 0; k < n; k++) spawnBolt(i.onsetStrength, i.charge);
    }
    let flashTarget = 0;
    for (const b of bolts) {
      if (!b.active) continue;
      b.age += i.realDt;
      const u = b.age / b.life;
      if (u >= 1) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }
      const reveal = Math.min(1.05, b.age / 0.05);
      const flicker = 0.6 + 0.4 * Math.sin(b.age * 95 + b.seed * 20);
      const restrike = b.seed > 0.4 ? Math.exp(-(((u - 0.45) / 0.07) ** 2)) * 0.9 : 0;
      const fade = b.strength * (Math.pow(1 - u, 1.4) * flicker + restrike * (1 - u)) * (b.age < 0.05 ? 0.5 : 1);
      b.mat.uniforms.uFade.value = fade;
      b.mat.uniforms.uReveal.value = reveal;
      flashTarget = Math.max(flashTarget, fade * Math.min(1, reveal));
    }
    flash = Math.max(flash * Math.exp(-i.realDt * 5), flashTarget);
    uFlash.value = flash;
    skyMat.uniforms.uFlashX.value = flashX;

    // Parallax
    for (const layer of layers) {
      layer.scroll = (layer.scroll + i.dt * layer.def.speed) % PINE_SPAN;
      const un = layer.mat.uniforms;
      un.uScroll.value = layer.scroll;
      un.uSway.value = layer.def.sway * (1 + 1.5 * i.bass);
      un.uRim.value = flash * layer.def.rim;
      const trees = Math.round(layer.def.maxTrees * (0.08 + 0.92 * i.density));
      layer.geo.setDrawRange(0, GROUND_VERTS + trees * VERTS_PER_TREE);
    }

    // Fireflies (hand attraction eases in and out rather than popping)
    handAmount += ((i.hand ? 1 : 0) - handAmount) * (1 - Math.exp(-i.realDt * 3));
    const total = Math.round(i.life * 300);
    const back = Math.min(FIREFLIES_PER_GROUP, total >> 1);
    for (let g = 0; g < fireflies.length; g++) {
      const f = fireflies[g];
      f.geo.setDrawRange(0, g === 0 ? back : Math.min(FIREFLIES_PER_GROUP, total - back));
      const un = f.mat.uniforms;
      un.uMid.value = i.mid;
      un.uBeat.value = i.beat;
      const hand = un.uHand.value as THREE.Vector3;
      if (i.hand) hand.set((i.hand.x * 2 - 1) * aspect, 1 - i.hand.y * 2, handAmount);
      else hand.z = handAmount;
    }

    // Silhouette
    maskAmount += ((i.mask ? 1 : 0) - maskAmount) * (1 - Math.exp(-i.realDt * 4));
    if (i.mask) maskMat.uniforms.uMask.value = i.mask;
    maskMat.uniforms.uMirrored.value = i.maskMirrored ? 1 : 0;
    maskMat.uniforms.uAmount.value = maskAmount;
    maskMesh.visible = maskAmount > 0.01 && maskMat.uniforms.uMask.value !== null;
  };

  return {
    scene,
    camera,
    update,
    resize(w, h) {
      aspect = w / Math.max(1, h);
      camera.left = -aspect;
      camera.right = aspect;
      camera.updateProjectionMatrix();
      uAspect.value = aspect;
      (skyMat.uniforms.uMoon.value as THREE.Vector2).set(aspect * 0.52, 0.6);
      for (const f of fireflies) f.mat.uniforms.uPx.value = h / 1080;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      scene.clear();
    },
  };
};
