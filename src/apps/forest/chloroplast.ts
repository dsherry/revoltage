import * as THREE from 'three';
import type { SceneFactory } from './types';
import { BG_FRAG, BG_VERT, CHLORO_FRAG, CHLORO_VERT, MAX_CELLS, NODE_FRAG, NODE_VERT } from './chloroplast-shaders';

const PER_CELL = 64;
const MAX_PARTICLES = MAX_CELLS * PER_CELL;
const MAX_HOPS = 160;
const SUB = 4; // jagged sub-segments per spark hop
const LINE_VERTS = MAX_HOPS * SUB * 2;
const SPARK_LIFE = 0.4;
const HOP_DELAY = 0.035;
const GROW = 0.04;
const GONE = 4; // additive distance offset that shrinks a cell away entirely
const WALL_MARGIN = 0.035; // wall wobble + wall glow + half a chloroplast
const MAX_ORBIT = 0.5;

const halton = (i: number, b: number) => {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
};
const smooth01 = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Chloroplast Flow: plant cells with streaming chloroplasts, light shafts and electron sparks on each hit. */
export const createChloroplast: SceneFactory = (ctx) => {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  let aspect = ctx.width / ctx.height;

  // --- Cells: Halton seeds (well spread for any prefix, so density just changes how many are active).
  const baseX = new Float64Array(MAX_CELLS), baseY = new Float64Array(MAX_CELLS);
  const wanF = new Float64Array(MAX_CELLS * 4);
  const cellDir = new Float64Array(MAX_CELLS);
  for (let c = 0; c < MAX_CELLS; c++) {
    wanF[c * 4] = 0.03 + Math.random() * 0.04;
    wanF[c * 4 + 1] = 0.03 + Math.random() * 0.04;
    wanF[c * 4 + 2] = Math.random() * Math.PI * 2;
    wanF[c * 4 + 3] = Math.random() * Math.PI * 2;
    cellDir[c] = Math.random() < 0.5 ? -1 : 1;
  }
  const placeSeeds = () => {
    for (let c = 0; c < MAX_CELLS; c++) {
      baseX[c] = (halton(c + 1, 2) * 2 - 1) * aspect * 1.02;
      baseY[c] = (halton(c + 1, 3) * 2 - 1) * 1.02;
    }
  };
  const cx = new Float64Array(MAX_CELLS), cy = new Float64Array(MAX_CELLS);
  const cr = new Float64Array(MAX_CELLS); // orbit radius: inscribed circle minus a margin
  const cw = new Float64Array(MAX_CELLS); // visibility (eased weight)
  const coff = new Float64Array(MAX_CELLS); // additive Voronoi offset
  const weight = new Float64Array(MAX_CELLS);
  const exc = new Float64Array(MAX_CELLS);
  const seedU = new Float32Array(MAX_CELLS * 4);
  const cellU = new Float32Array(MAX_CELLS * 4);

  // --- Shared uniforms (the same objects are referenced by several materials).
  const u = {
    uTime: { value: 0 },
    uAspect: { value: aspect },
    uShaft: { value: 0 },
    uHand: { value: new THREE.Vector3() },
    uMask: { value: null as THREE.Texture | null },
    uMaskOn: { value: 0 },
    uMaskMirror: { value: 0 },
    uColA: { value: new THREE.Color() },
    uColB: { value: new THREE.Color() },
    uColC: { value: new THREE.Color() },
    uIntensity: { value: 1 },
    uPx: { value: ctx.height / 2 },
  };

  // --- Background: full-screen Voronoi cells + light shafts.
  const bgGeo = new THREE.PlaneGeometry(2, 2);
  const bgMat = new THREE.ShaderMaterial({
    vertexShader: BG_VERT,
    fragmentShader: BG_FRAG,
    uniforms: {
      ...u,
      uSeeds: { value: seedU },
      uPulse: { value: 1 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const bg = new THREE.Mesh(bgGeo, bgMat);
  bg.frustumCulled = false;
  bg.renderOrder = 0;
  scene.add(bg);

  // --- Chloroplasts: orbits are computed on the GPU from static per-particle attributes.
  const orbitA = new Float32Array(MAX_PARTICLES * 4); // cell, radius fraction, phase, angular speed
  const lookA = new Float32Array(MAX_PARTICLES * 4); // size, rank, random, unused
  for (let k = 0; k < MAX_PARTICLES; k++) {
    const c = k % MAX_CELLS;
    const rad = Math.random() < 0.75 ? 0.62 + 0.3 * Math.random() : 0.22 + 0.38 * Math.random();
    orbitA[k * 4] = c;
    orbitA[k * 4 + 1] = rad;
    orbitA[k * 4 + 2] = Math.random() * Math.PI * 2;
    orbitA[k * 4 + 3] = cellDir[c] * (0.16 + 0.08 * Math.random()) * (1.3 - 0.5 * rad);
    lookA[k * 4] = 0.016 + 0.01 * Math.random();
    lookA[k * 4 + 1] = Math.floor(k / MAX_CELLS) / PER_CELL;
    lookA[k * 4 + 2] = Math.random();
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3));
  pGeo.setAttribute('aOrbit', new THREE.BufferAttribute(orbitA, 4));
  pGeo.setAttribute('aLook', new THREE.BufferAttribute(lookA, 4));
  const pMat = new THREE.ShaderMaterial({
    vertexShader: CHLORO_VERT,
    fragmentShader: CHLORO_FRAG,
    uniforms: {
      ...u,
      uCells: { value: cellU },
      uFlow: { value: 0 },
      uFill: { value: 0 },
      uClock: { value: 0 },
      uLevel: { value: 0 },
      uTreble: { value: 0 },
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const points = new THREE.Points(pGeo, pMat);
  points.frustumCulled = false;
  points.renderOrder = 1;
  scene.add(points);

  // --- Electron sparks: a fixed pool of jagged line hops plus glowing nodes at the hit chloroplasts.
  const linePos = new Float32Array(LINE_VERTS * 3);
  const lineCol = new Float32Array(LINE_VERTS * 3);
  const lineGeo = new THREE.BufferGeometry();
  const linePosAttr = new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage);
  const lineColAttr = new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage);
  lineGeo.setAttribute('position', linePosAttr);
  lineGeo.setAttribute('color', lineColAttr);
  lineGeo.setDrawRange(0, 0);
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  lines.renderOrder = 2;
  scene.add(lines);

  const nodePos = new Float32Array(MAX_HOPS * 2 * 3);
  const nodeCol = new Float32Array(MAX_HOPS * 2 * 3);
  const nodeGeo = new THREE.BufferGeometry();
  const nodePosAttr = new THREE.BufferAttribute(nodePos, 3).setUsage(THREE.DynamicDrawUsage);
  const nodeColAttr = new THREE.BufferAttribute(nodeCol, 3).setUsage(THREE.DynamicDrawUsage);
  nodeGeo.setAttribute('position', nodePosAttr);
  nodeGeo.setAttribute('aColor', nodeColAttr);
  nodeGeo.setDrawRange(0, 0);
  const nodeMat = new THREE.ShaderMaterial({
    vertexShader: NODE_VERT,
    fragmentShader: NODE_FRAG,
    uniforms: { uSize: { value: 0.045 * u.uPx.value } },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const nodes = new THREE.Points(nodeGeo, nodeMat);
  nodes.frustumCulled = false;
  nodes.renderOrder = 3;
  scene.add(nodes);

  const hopA = new Int32Array(MAX_HOPS), hopB = new Int32Array(MAX_HOPS);
  const hopAge = new Float64Array(MAX_HOPS).fill(SPARK_LIFE);
  const hopStr = new Float64Array(MAX_HOPS);
  const hopFirst = new Uint8Array(MAX_HOPS);
  let hopHead = 0;
  const chain = new Int32Array(16);

  // --- State.
  let flow = 0, fill = 0, clock = 0;
  let handAmt = 0, hx = 0, hy = 0, maskOn = 0;
  let first = true;

  // Orbit of particle k, written into ox/oy. Keep in sync with CHLORO_VERT.
  let ox = 0, oy = 0;
  const orbit = (k: number) => {
    const o = k * 4;
    const c = orbitA[o];
    const ph = orbitA[o + 2];
    const a = ph + flow * orbitA[o + 3];
    const r = orbitA[o + 1] * cr[c] * (1 + 0.06 * Math.sin(3 * a + ph * 1.7));
    ox = cx[c] + r * Math.cos(a);
    oy = cy[c] + r * Math.sin(a);
  };
  const visible = (k: number) => cw[k % MAX_CELLS] * clamp01((fill - lookA[k * 4 + 1]) * 64);

  const pickStart = () => {
    for (let tries = 0; tries < 60; tries++) {
      const k = Math.floor(Math.random() * MAX_PARTICLES);
      if (visible(k) > 0.5) return k;
    }
    return -1;
  };

  // A near neighbour of `from`, mostly in the same cell, not already in the chain.
  const nextHop = (from: number, len: number) => {
    orbit(from);
    const fx = ox, fy = oy, cf = from % MAX_CELLS;
    const penalty = Math.random() < 0.2 ? 0 : 0.08;
    let b0 = -1, b1 = -1, b2 = -1, d0 = Infinity, d1 = Infinity, d2 = Infinity;
    for (let k = 0; k < MAX_PARTICLES; k++) {
      const c = k % MAX_CELLS;
      if (visible(k) < 0.5) continue;
      const sx = cx[c] - fx, sy = cy[c] - fy, reach = cr[c] + 0.3;
      if (sx * sx + sy * sy > reach * reach) continue;
      let seen = false;
      for (let j = 0; j < len; j++) if (chain[j] === k) { seen = true; break; }
      if (seen) continue;
      orbit(k);
      let d = Math.hypot(ox - fx, oy - fy);
      if (d < 0.022) continue;
      if (c !== cf) d += penalty;
      if (d < d0) { b2 = b1; d2 = d1; b1 = b0; d1 = d0; b0 = k; d0 = d; }
      else if (d < d1) { b2 = b1; d2 = d1; b1 = k; d1 = d; }
      else if (d < d2) { b2 = k; d2 = d; }
    }
    const r = Math.random();
    const pick = r < 0.5 ? b0 : r < 0.8 ? b1 : b2;
    return pick >= 0 ? pick : b0;
  };

  const spawnChain = (hops: number, strength: number) => {
    let k = pickStart();
    if (k < 0) return;
    chain[0] = k;
    let len = 1;
    for (let h = 0; h < hops && len < chain.length; h++) {
      const next = nextHop(k, len);
      if (next < 0) break;
      const s = hopHead;
      hopHead = (hopHead + 1) % MAX_HOPS;
      hopA[s] = k;
      hopB[s] = next;
      hopAge[s] = -h * HOP_DELAY;
      hopStr[s] = strength;
      hopFirst[s] = h === 0 ? 1 : 0;
      chain[len++] = next;
      k = next;
    }
  };

  const resize = (w: number, h: number) => {
    aspect = w / h;
    camera.left = -aspect;
    camera.right = aspect;
    camera.updateProjectionMatrix();
    placeSeeds();
    u.uAspect.value = aspect;
    u.uPx.value = h / 2;
    nodeMat.uniforms.uSize.value = 0.045 * u.uPx.value;
  };
  resize(ctx.width, ctx.height);

  return {
    scene,
    camera,
    update(i) {
      const rdt = i.realDt;
      clock += rdt;
      flow += i.dt * (0.6 + 0.8 * Math.min(i.level, 1.5));

      // Cells: active count from density; cells grow in / shrink away over a few seconds.
      const active = Math.round(8 + 16 * i.density);
      const ease = first ? 1 : 1 - Math.exp(-rdt * 0.8);
      for (let c = 0; c < MAX_CELLS; c++) {
        weight[c] += ((c < active ? 1 : 0) - weight[c]) * ease;
        cw[c] = smooth01(clamp01(weight[c]));
        coff[c] = (1 - cw[c]) * GONE;
        cx[c] = baseX[c] + 0.07 * Math.sin(i.t * wanF[c * 4] + wanF[c * 4 + 2]);
        cy[c] = baseY[c] + 0.07 * Math.sin(i.t * wanF[c * 4 + 1] + wanF[c * 4 + 3]);
        exc[c] *= Math.exp(-rdt * 3);
      }
      // Distance from a seed to its (additively weighted) cell boundary is min over neighbours of (D + cj - ci) / 2.
      for (let c = 0; c < MAX_CELLS; c++) {
        let m = MAX_ORBIT + WALL_MARGIN;
        if (cw[c] > 0.001) {
          for (let j = 0; j < MAX_CELLS; j++) {
            if (j === c) continue;
            const v = (Math.hypot(cx[j] - cx[c], cy[j] - cy[c]) + coff[j] - coff[c]) * 0.5;
            if (v < m) m = v;
          }
        } else {
          m = 0;
        }
        cr[c] = Math.max(0, m - WALL_MARGIN);
      }
      const perCell = (300 + 1200 * i.density) / active;
      fill += (perCell / PER_CELL - fill) * (first ? 1 : 1 - Math.exp(-rdt * 1.5));
      first = false;

      // Sparks first so their cell excitation lands in this frame's uniforms.
      if (i.onset) spawnChain(Math.round(2 + i.charge * 8 * i.onsetStrength), 0.4 + 0.6 * i.onsetStrength);
      const cC = i.colorC;
      let lv = 0, nv = 0;
      for (let s = 0; s < MAX_HOPS; s++) {
        let age = hopAge[s];
        if (age >= SPARK_LIFE) continue;
        age += rdt;
        hopAge[s] = age;
        if (age < 0 || age >= SPARK_LIFE) continue;
        const str = hopStr[s];
        const bc = hopB[s] % MAX_CELLS;
        if (age - rdt < 0) exc[bc] = Math.max(exc[bc], 0.45 * str);

        orbit(hopA[s]);
        const ax = ox, ay = oy;
        orbit(hopB[s]);
        const grow = Math.min(1, age / GROW);
        const ex = ax + (ox - ax) * grow, ey = ay + (oy - ay) * grow;
        const fade = (1 - age / SPARK_LIFE) ** 2;
        const br = (1.2 + 2.3 * str) * fade * i.intensity * (0.75 + 0.5 * Math.random());
        const r = (cC.r + 0.25) * br, g = (cC.g + 0.25) * br, b = (cC.b + 0.25) * br;
        const dx = ex - ax, dy = ey - ay, len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len, amp = len * 0.18;
        let px = ax, py = ay;
        for (let j = 1; j <= SUB; j++) {
          const f = j / SUB, jit = j < SUB ? (Math.random() - 0.5) * 2 * amp : 0;
          const qx = ax + dx * f + nx * jit, qy = ay + dy * f + ny * jit;
          const o = lv * 3;
          linePos[o] = px; linePos[o + 1] = py; linePos[o + 2] = 0;
          linePos[o + 3] = qx; linePos[o + 4] = qy; linePos[o + 5] = 0;
          lineCol[o] = r; lineCol[o + 1] = g; lineCol[o + 2] = b;
          lineCol[o + 3] = r; lineCol[o + 4] = g; lineCol[o + 5] = b;
          lv += 2;
          px = qx; py = qy;
        }
        const nb = grow < 1 ? 0 : 0.5;
        const o = nv * 3;
        nodePos[o] = ex; nodePos[o + 1] = ey; nodePos[o + 2] = 0;
        nodeCol[o] = r * nb; nodeCol[o + 1] = g * nb; nodeCol[o + 2] = b * nb;
        nv++;
        if (hopFirst[s]) {
          const o2 = nv * 3;
          nodePos[o2] = ax; nodePos[o2 + 1] = ay; nodePos[o2 + 2] = 0;
          nodeCol[o2] = r * 0.5; nodeCol[o2 + 1] = g * 0.5; nodeCol[o2 + 2] = b * 0.5;
          nv++;
        }
      }
      lineGeo.setDrawRange(0, lv);
      if (lv > 0) {
        linePosAttr.addUpdateRange(0, lv * 3);
        lineColAttr.addUpdateRange(0, lv * 3);
        linePosAttr.needsUpdate = true;
        lineColAttr.needsUpdate = true;
      }
      nodeGeo.setDrawRange(0, nv);
      if (nv > 0) {
        nodePosAttr.addUpdateRange(0, nv * 3);
        nodeColAttr.addUpdateRange(0, nv * 3);
        nodePosAttr.needsUpdate = true;
        nodeColAttr.needsUpdate = true;
      }

      for (let c = 0; c < MAX_CELLS; c++) {
        const o = c * 4;
        seedU[o] = cx[c]; seedU[o + 1] = cy[c]; seedU[o + 2] = coff[c]; seedU[o + 3] = exc[c];
        cellU[o] = cx[c]; cellU[o + 1] = cy[c]; cellU[o + 2] = cr[c]; cellU[o + 3] = cw[c];
      }

      // Light: hand pool and person mask fade in and out rather than popping.
      if (i.hand) {
        hx = (i.hand.x * 2 - 1) * aspect;
        hy = 1 - i.hand.y * 2;
      }
      handAmt += ((i.hand ? 1 : 0) - handAmt) * (1 - Math.exp(-rdt * 4));
      if (i.mask) u.uMask.value = i.mask;
      maskOn += ((i.mask ? 1 : 0) - maskOn) * (1 - Math.exp(-rdt * 3));

      u.uTime.value = i.t;
      u.uShaft.value = i.light * (0.3 + Math.min(i.level, 1.5));
      u.uHand.value.set(hx, hy, handAmt * 0.85);
      u.uMaskOn.value = maskOn;
      u.uMaskMirror.value = i.maskMirrored ? 1 : 0;
      u.uColA.value.copy(i.colorA);
      u.uColB.value.copy(i.colorB);
      u.uColC.value.copy(i.colorC);
      u.uIntensity.value = i.intensity;
      bgMat.uniforms.uPulse.value = 0.8 + 0.5 * i.bass + 0.15 * i.beat + 0.07 * Math.sin(clock * 0.5);
      const pu = pMat.uniforms;
      pu.uFlow.value = flow;
      pu.uFill.value = fill;
      pu.uClock.value = clock;
      pu.uLevel.value = i.level;
      pu.uTreble.value = i.treble;
    },
    resize,
    dispose() {
      bgGeo.dispose(); bgMat.dispose();
      pGeo.dispose(); pMat.dispose();
      lineGeo.dispose(); lineMat.dispose();
      nodeGeo.dispose(); nodeMat.dispose();
    },
  };
};
