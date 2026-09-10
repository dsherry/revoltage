import * as THREE from 'three';
import type { ForestInputs, SceneFactory } from './types';
import { buildForest, MAX_TREES, mulberry32 } from './canopy-tree';
import {
  BG_FRAG, BG_VERT, BRANCH_FRAG, BRANCH_VERT, FLASHES, FLY_FRAG, FLY_VERT, LEAF_FRAG, LEAF_VERT, PULSE_FRAG, PULSE_VERT,
} from './canopy-shaders';

const GROUND = -0.55;
const GROW_SECONDS = 40;
const GROWTH_MAX = 1.1;
const MAX_PULSES = 64;
const TRAIL = 40;
const TRAIL_LEN = 0.3;
const TRAIL_STEP = TRAIL_LEN / TRAIL;
const MAX_PATH = 96;
const MAX_FLIES = 150;
/** Left-to-right rank of each tree among the visible ones, so new trees appear between existing ones. */
const HOME = [0.5, 0.18, 0.82, 0.34, 0.66, 0.03, 0.97];

const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Canopy Current: procedural trees growing in a dark field, fed by a drifting sun and struck by electric pulses. */
export const createCanopy: SceneFactory = (ctx) => {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 5;

  const model = buildForest(20260910);
  const { trees, nodeX: NX, nodeY: NY, nodeDist: ND, nodeParent: NP, nodeSway: NW } = model;

  const treeU: THREE.Vector4[] = [];
  const treeBU: THREE.Vector4[] = [];
  for (let k = 0; k < MAX_TREES; k++) {
    treeU.push(new THREE.Vector4(0, 1, 0, 0));
    treeBU.push(new THREE.Vector4(0, trees[k].phase, 0, 0));
  }
  const flashU: THREE.Vector4[] = [];
  for (let f = 0; f < FLASHES; f++) flashU.push(new THREE.Vector4(0, 0, -10, 0));

  // One shared uniform set: every material picks the ones its program declares.
  const U = {
    uTime: { value: 0 },
    uRealTime: { value: 0 },
    uAspect: { value: 1 },
    uGround: { value: GROUND },
    uPx: { value: 2 / 1080 },
    uPxScale: { value: 1 },
    uColA: { value: new THREE.Color() },
    uColB: { value: new THREE.Color() },
    uColC: { value: new THREE.Color() },
    uIntensity: { value: 1 },
    uLight: { value: 0.6 },
    uLevel: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uTreble: { value: 0 },
    uTree: { value: treeU },
    uTreeB: { value: treeBU },
    uSwayAmp: { value: 0.01 },
    uNod: { value: 0 },
    uSun: { value: new THREE.Vector2(0, 0.6) },
    uSunR: { value: 0.045 },
    uGroundGlow: { value: 0.1 },
    uFlash: { value: flashU },
    uHand: { value: new THREE.Vector2() },
    uHandAmt: { value: 0 },
    uLife: { value: 0 },
  };

  const material = (vertexShader: string, fragmentShader: string, blending: THREE.Blending) =>
    new THREE.ShaderMaterial({
      uniforms: U, vertexShader, fragmentShader, blending,
      transparent: blending !== THREE.NoBlending, depthTest: false, depthWrite: false,
    });
  const bgMat = material(BG_VERT, BG_FRAG, THREE.NoBlending);
  const branchMat = material(BRANCH_VERT, BRANCH_FRAG, THREE.NormalBlending);
  const leafMat = material(LEAF_VERT, LEAF_FRAG, THREE.AdditiveBlending);
  const pulseMat = material(PULSE_VERT, PULSE_FRAG, THREE.AdditiveBlending);
  const flyMat = material(FLY_VERT, FLY_FRAG, THREE.AdditiveBlending);

  // Pulse trail points, rewritten each frame (only the used range is uploaded).
  const pulseGeo = new THREE.BufferGeometry();
  const pulsePos = new Float32Array(MAX_PULSES * TRAIL * 3);
  const pulseInfo = new Float32Array(MAX_PULSES * TRAIL * 4);
  const pulsePosAttr = new THREE.BufferAttribute(pulsePos, 3).setUsage(THREE.DynamicDrawUsage);
  const pulseInfoAttr = new THREE.BufferAttribute(pulseInfo, 4).setUsage(THREE.DynamicDrawUsage);
  pulseGeo.setAttribute('position', pulsePosAttr);
  pulseGeo.setAttribute('aInfo', pulseInfoAttr);
  pulseGeo.setDrawRange(0, 0);

  // Fireflies move entirely in the vertex shader; position.x holds the index (for the life fade).
  const flyGeo = new THREE.BufferGeometry();
  {
    const rng = mulberry32(7331);
    const pos = new Float32Array(MAX_FLIES * 3);
    const seeds = new Float32Array(MAX_FLIES * 4);
    for (let f = 0; f < MAX_FLIES; f++) {
      pos[f * 3] = f;
      for (let j = 0; j < 4; j++) seeds[f * 4 + j] = rng();
    }
    flyGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    flyGeo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  }

  const bgGeo = new THREE.PlaneGeometry(2, 2);
  const objects: THREE.Object3D[] = [
    new THREE.Mesh(bgGeo, bgMat),
    new THREE.Mesh(model.branches, branchMat),
    new THREE.Points(model.leaves, leafMat),
    new THREE.Points(pulseGeo, pulseMat),
    new THREE.Points(flyGeo, flyMat),
  ];
  objects.forEach((o, idx) => {
    o.renderOrder = idx;
    o.frustumCulled = false; // positions are computed in the vertex shaders
    scene.add(o);
  });
  const pulsePoints = objects[3];
  const flies = objects[4];

  // --- Tree state.
  const tx = new Float32Array(MAX_TREES);
  const tScale = new Float32Array(MAX_TREES);
  const tVis = new Float32Array(MAX_TREES);
  const tGrowth = new Float32Array(MAX_TREES);
  const tEnergy = new Float32Array(MAX_TREES);
  const sorted = new Int32Array(MAX_TREES);
  const rank = new Int32Array(MAX_TREES);
  for (let k = 0; k < MAX_TREES; k++) tGrowth[k] = -0.012 * k; // slight stagger
  let visCount = -1;

  const relayout = (n: number) => {
    for (let k = 0; k < n; k++) sorted[k] = k;
    for (let a = 1; a < n; a++) {
      const v = sorted[a];
      let b = a - 1;
      while (b >= 0 && HOME[sorted[b]] > HOME[v]) { sorted[b + 1] = sorted[b]; b--; }
      sorted[b + 1] = v;
    }
    for (let r = 0; r < n; r++) rank[sorted[r]] = r;
  };

  // --- Pulse pool (structure of arrays; paths are copied in at spawn).
  const pActive = new Uint8Array(MAX_PULSES);
  const pArrived = new Uint8Array(MAX_PULSES);
  const pTree = new Int32Array(MAX_PULSES);
  const pCount = new Int32Array(MAX_PULSES);
  const pS = new Float32Array(MAX_PULSES);
  const pSpeed = new Float32Array(MAX_PULSES);
  const pLen = new Float32Array(MAX_PULSES);
  const pStrength = new Float32Array(MAX_PULSES);
  const pAge = new Float32Array(MAX_PULSES);
  const pathX = new Float32Array(MAX_PULSES * MAX_PATH);
  const pathY = new Float32Array(MAX_PULSES * MAX_PATH);
  const pathS = new Float32Array(MAX_PULSES * MAX_PATH);
  const pathW = new Float32Array(MAX_PULSES * MAX_PATH);
  const anc = new Int32Array(256);
  let flashIdx = 0;

  const addPt = (o: number, n: number, x: number, y: number, w: number): number => {
    if (n >= MAX_PATH) return n;
    const j = o + n;
    pathX[j] = x; pathY[j] = y; pathW[j] = w;
    pathS[j] = n === 0 ? 0 : pathS[j - 1] + Math.hypot(x - pathX[j - 1], y - pathY[j - 1]);
    return n + 1;
  };

  /** Root tip → base → twig tip, clipped to what has grown (dist ≤ lim). Returns the point count. */
  const buildPath = (slot: number, base: number, rootTip: number, twigTip: number, lim: number): number => {
    const o = slot * MAX_PATH;
    let n = 0;
    let node = rootTip;
    while (node !== base && node >= 0) {
      if (ND[node] <= lim) n = addPt(o, n, NX[node], NY[node], NW[node]);
      node = NP[node];
    }
    n = addPt(o, n, NX[base], NY[base], 0);
    let m = 0;
    node = twigTip;
    while (node !== base && node >= 0 && m < anc.length) { anc[m++] = node; node = NP[node]; }
    let prev = base;
    for (let j = m - 1; j >= 0; j--) {
      const c = anc[j];
      if (ND[c] > lim) {
        const f = (lim - ND[prev]) / Math.max(ND[c] - ND[prev], 1e-6);
        if (f > 0.01) {
          n = addPt(o, n, NX[prev] + (NX[c] - NX[prev]) * f, NY[prev] + (NY[c] - NY[prev]) * f, NW[prev] + (NW[c] - NW[prev]) * f);
        }
        break;
      }
      n = addPt(o, n, NX[c], NY[c], NW[c]);
      prev = c;
    }
    return n;
  };

  const spawnPulse = (k: number, delay: number, strength: number) => {
    let slot = -1, oldest = 0, oldestAge = -1;
    for (let j = 0; j < MAX_PULSES; j++) {
      if (!pActive[j]) { slot = j; break; }
      if (pAge[j] > oldestAge) { oldestAge = pAge[j]; oldest = j; }
    }
    if (slot < 0) slot = oldest;
    const tr = trees[k];
    const lim = clamp01(tGrowth[k]) * tr.maxDist;
    let tip = tr.twigTips[0];
    for (let tries = 0; tries < 6; tries++) {
      tip = tr.twigTips[(Math.random() * tr.twigTips.length) | 0];
      if (ND[tip] <= lim) break;
    }
    const root = tr.rootTips[(Math.random() * tr.rootTips.length) | 0];
    const n = buildPath(slot, tr.base, root, tip, lim);
    const len = n > 1 ? pathS[slot * MAX_PATH + n - 1] : 0;
    if (len < 0.02) { pActive[slot] = 0; return; }
    const speed = Math.max(len / (0.5 + Math.random() * 0.3), 1);
    pActive[slot] = 1;
    pArrived[slot] = 0;
    pTree[slot] = k;
    pCount[slot] = n;
    pLen[slot] = len;
    pSpeed[slot] = speed;
    pS[slot] = -delay * speed;
    pStrength[slot] = strength;
    pAge[slot] = 0;
  };

  const addFlash = (x: number, y: number, k: number, strength: number) => {
    flashU[flashIdx].set(x, y, k, 0.8 + 0.6 * strength);
    flashIdx = (flashIdx + 1) % FLASHES;
  };

  const updatePulses = (rdt: number) => {
    let m = 0;
    for (let p = 0; p < MAX_PULSES; p++) {
      if (!pActive[p]) continue;
      pAge[p] += rdt;
      pS[p] += pSpeed[p] * rdt;
      const s = pS[p], len = pLen[p], o = p * MAX_PATH, n = pCount[p], k = pTree[p];
      if (!pArrived[p] && s >= len) {
        pArrived[p] = 1;
        addFlash(pathX[o + n - 1], pathY[o + n - 1], k, pStrength[p]);
        tEnergy[k] = Math.min(1.5, tEnergy[k] + 0.15 * pStrength[p]);
      }
      if (s - TRAIL_LEN > len) { pActive[p] = 0; continue; }
      const head = (2.2 + 2.0 * pStrength[p]) * tVis[k];
      let j = n - 2;
      for (let q = 0; q < TRAIL; q++) {
        const sk = s - q * TRAIL_STEP;
        if (sk < 0) break;
        if (sk > len) continue; // after arrival the trail drains into the twig tip
        while (j > 0 && pathS[o + j] > sk) j--;
        const s0 = pathS[o + j], s1 = pathS[o + j + 1];
        const f = s1 > s0 ? (sk - s0) / (s1 - s0) : 0;
        const a = o + j, b = a + 1;
        const fall = 1 - q / TRAIL;
        pulsePos[m * 3] = pathX[a] + (pathX[b] - pathX[a]) * f;
        pulsePos[m * 3 + 1] = pathY[a] + (pathY[b] - pathY[a]) * f;
        pulsePos[m * 3 + 2] = 0;
        pulseInfo[m * 4] = k;
        pulseInfo[m * 4 + 1] = pathW[a] + (pathW[b] - pathW[a]) * f;
        pulseInfo[m * 4 + 2] = head * fall * fall * (q === 0 ? 1.5 : 0.5);
        pulseInfo[m * 4 + 3] = 3 + 8 * fall * Math.sqrt(fall);
        m++;
      }
    }
    pulseGeo.setDrawRange(0, m);
    pulsePoints.visible = m > 0;
    if (m > 0) {
      pulsePosAttr.clearUpdateRanges();
      pulsePosAttr.addUpdateRange(0, m * 3);
      pulsePosAttr.needsUpdate = true;
      pulseInfoAttr.clearUpdateRanges();
      pulseInfoAttr.addUpdateRange(0, m * 4);
      pulseInfoAttr.needsUpdate = true;
    }
  };

  /** Pitch picks the tree left→right; null picks a random one. Falls back to the most grown tree. */
  const pickTree = (pitch: number | null, n: number): number => {
    const r = pitch === null ? (Math.random() * n) | 0 : Math.min(n - 1, Math.floor(pitch * n));
    let k = sorted[r];
    if (tGrowth[k] > 0.04) return k;
    let best = -1, bestG = 0.04;
    for (let r2 = 0; r2 < n; r2++) {
      const k2 = sorted[r2];
      if (tGrowth[k2] > bestG) { bestG = tGrowth[k2]; best = k2; }
    }
    k = best;
    return k;
  };

  // --- Frame state.
  let aspect = ctx.width / Math.max(1, ctx.height);
  let first = true;
  let beatSm = 0, lifeSm = 0, groundKick = 0, handAmt = 0;
  let sunX = 0, sunY = 0.6;

  const resize = (w: number, h: number) => {
    aspect = w / Math.max(1, h);
    camera.left = -aspect;
    camera.right = aspect;
    camera.top = 1;
    camera.bottom = -1;
    camera.updateProjectionMatrix();
    U.uAspect.value = aspect;
    U.uPx.value = 2 / Math.max(1, h);
    U.uPxScale.value = h / 1080;
  };
  resize(ctx.width, ctx.height);

  return {
    scene,
    camera,
    update(i: ForestInputs) {
      const rdt = Math.min(i.realDt, 0.1);
      const dt = Math.min(i.dt, 0.3);
      U.uTime.value = i.t;
      U.uRealTime.value += rdt;
      U.uColA.value.copy(i.colorA);
      U.uColB.value.copy(i.colorB);
      U.uColC.value.copy(i.colorC);
      U.uIntensity.value = i.intensity;
      U.uLight.value = i.light;
      U.uLevel.value = i.level;
      U.uBass.value = i.bass;
      U.uMid.value = i.mid;
      U.uTreble.value = i.treble;

      // Trees: density picks how many; they fade in/out and glide to evenly spaced slots.
      const n = Math.min(MAX_TREES, Math.max(3, Math.round(3 + i.density * 4)));
      if (n !== visCount) { visCount = n; relayout(n); }
      const fit = Math.sqrt(Math.min(1, Math.max(0.5, aspect / (16 / 9))));
      const layoutScale = (1.12 - (n - 3) * 0.06) * fit;
      const aVis = ease(rdt, 1.2), aMove = ease(rdt, 1.5);
      const energyDecay = Math.exp(-rdt * 2.5);
      for (let k = 0; k < MAX_TREES; k++) {
        const visible = k < n;
        const tr = trees[k];
        if (visible) {
          const targetX = (((rank[k] + 0.5) / n) * 2 - 1 + tr.jitter) * aspect * 0.9;
          const targetS = tr.scale * layoutScale;
          if (first || tVis[k] < 0.02) {
            tx[k] = targetX;
            tScale[k] = targetS;
            if (first) tVis[k] = 1;
          } else {
            tx[k] += (targetX - tx[k]) * aMove;
            tScale[k] += (targetS - tScale[k]) * aMove;
          }
          tGrowth[k] = Math.min(GROWTH_MAX, tGrowth[k] + (dt / GROW_SECONDS) * tr.rate);
        } else if (tVis[k] < 0.01) {
          tGrowth[k] = 0; // regrow from a seedling next time it's shown
        }
        tVis[k] += ((visible ? 1 : 0) - tVis[k]) * aVis;
        tEnergy[k] *= energyDecay;
        treeU[k].set(tx[k], tScale[k], tVis[k], tGrowth[k]);
        treeBU[k].x = tEnergy[k];
      }

      // Electricity.
      if (i.onset) {
        const k = pickTree(i.pitch, n);
        if (k >= 0) {
          const count = Math.round(1 + i.charge * 4 * i.onsetStrength);
          for (let j = 0; j < count; j++) spawnPulse(k, j * 0.07 + Math.random() * 0.05, i.onsetStrength);
          tEnergy[k] = Math.min(1.5, tEnergy[k] + 0.3 + 0.4 * i.onsetStrength);
        }
        groundKick = Math.max(groundKick, 0.2 + 0.4 * i.onsetStrength);
      }
      updatePulses(rdt);
      const flashDecay = Math.exp(-rdt * 2.8);
      for (let f = 0; f < FLASHES; f++) flashU[f].w *= flashDecay;

      // Sway, stronger on the beat.
      beatSm += (i.beat - beatSm) * ease(rdt, 0.06);
      U.uSwayAmp.value = 0.01 + 0.01 * i.level;
      U.uNod.value = 0.018 * beatSm;

      // Sun: slow arc, or eased toward the hand.
      const theta = i.t * 0.02 + 0.5;
      const st = Math.sin(theta);
      let sx = st * aspect * 0.72, sy = 0.72 - 0.3 * st * st, tau = 2.5;
      if (i.hand) {
        sx = (i.hand.x * 2 - 1) * aspect;
        sy = 1 - i.hand.y * 2;
        tau = 0.45;
        U.uHand.value.set(sx, sy);
      }
      if (first) { sunX = sx; sunY = sy; }
      const aSun = ease(rdt, tau);
      sunX += (sx - sunX) * aSun;
      sunY += (sy - sunY) * aSun;
      U.uSun.value.set(sunX, sunY);
      U.uSunR.value = 0.035 + 0.02 * i.light;
      handAmt += ((i.hand ? 1 : 0) - handAmt) * ease(rdt, 0.6);
      U.uHandAmt.value = handAmt;

      // Ground glow and fireflies.
      groundKick *= Math.exp(-rdt * 3);
      U.uGroundGlow.value = 0.1 + 1.1 * i.bass + 0.5 * groundKick;
      lifeSm += (i.life - lifeSm) * ease(rdt, 0.5);
      const flyCount = lifeSm * MAX_FLIES;
      U.uLife.value = flyCount;
      const drawn = Math.min(MAX_FLIES, Math.ceil(flyCount));
      flyGeo.setDrawRange(0, drawn);
      flies.visible = drawn > 0;
      first = false;
    },
    resize,
    dispose() {
      bgGeo.dispose();
      model.branches.dispose();
      model.leaves.dispose();
      pulseGeo.dispose();
      flyGeo.dispose();
      bgMat.dispose();
      branchMat.dispose();
      leafMat.dispose();
      pulseMat.dispose();
      flyMat.dispose();
    },
  };
};
