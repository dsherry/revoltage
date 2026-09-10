import * as THREE from 'three';
import type { ForestInputs, SceneFactory } from './types';
import { buildLightning, LAYERS, ORDER } from './lightning';

type Pt = [number, number];

// Depth bands, far to near: the pine layer ground they run on, where they draw between the
// pine layers (renderOrder), how big they look, and how far out of the fog they are.
const BANDS = [
  { ground: LAYERS[0].ground, order: ORDER.pine0 + 0.5, scale: 0.4, near: 0 },
  { ground: LAYERS[1].ground, order: ORDER.pine1 + 0.5, scale: 0.65, near: 0.5 },
  { ground: LAYERS[2].ground, order: ORDER.mask + 0.5, scale: 1, near: 1 },
] as const;
type Band = (typeof BANDS)[number];

// Heights at the nearest band (scene units).
const H = { wolf: 0.13, bunny: 0.075, penguin: 0.4, turtle: 0.06, sloth: 0.16 };
const POOL = 8;
const BUNNY_CHANCE = 0.35;
const CROSS_SECONDS = 3.4;
const PARADE_SPEED = 0.35;
const OUTLINE_SCALE = 1.1;
const DARK = new THREE.Color(0.002, 0.0025, 0.004);
const LIGHT = new THREE.Color(0.018, 0.02, 0.026);

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

const polygon = (pts: Pt[]): THREE.Shape => {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) s.lineTo(pts[k][0], pts[k][1]);
  s.closePath();
  return s;
};

const ellipse = (cx: number, cy: number, rx: number, ry: number, rotation = 0): THREE.Shape => {
  const s = new THREE.Shape();
  s.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, rotation);
  return s;
};

/** Geometry centered on its bounding box, plus where that center sits in the animal's coordinates. */
function centered(geo: THREE.BufferGeometry): { geo: THREE.BufferGeometry; at: Pt } {
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  geo.translate(-c.x, -c.y, 0);
  return { geo, at: [c.x, c.y] };
}

/** A limb hanging from its pivot at the origin. */
const limb = (width: number, length: number) => new THREE.PlaneGeometry(width, length).translate(0, -length / 2, 0);

// Animals face +x with feet at y = 0, in units of their height.
const WOLF_BODY: Pt[] = [
  [-0.95, 0.56], [-0.7, 0.66], [-0.35, 0.72], [0.1, 0.7], [0.32, 0.75], [0.46, 0.84], [0.56, 0.94], [0.6, 1.0],
  [0.66, 0.93], [0.72, 0.9], [0.9, 0.83], [0.95, 0.77], [0.8, 0.72], [0.64, 0.66], [0.52, 0.5], [0.3, 0.45],
  [0.0, 0.44], [-0.35, 0.46], [-0.5, 0.5], [-0.68, 0.55], [-0.93, 0.51],
];
const shellArc: Pt[] = Array.from({ length: 17 }, (_, k): Pt => {
  const a = Math.PI * (1 - k / 16);
  return [0.55 * Math.cos(a), 0.22 + 0.62 * Math.sin(a)];
});

const GEO = {
  wolfBody: centered(new THREE.ShapeGeometry(polygon(WOLF_BODY))),
  wolfLeg: limb(0.075, 0.5),
  eye: new THREE.CircleGeometry(0.03, 12),
  smallEye: new THREE.CircleGeometry(0.022, 10),
  bunnyBody: centered(new THREE.ShapeGeometry([
    ellipse(-0.05, 0.3, 0.32, 0.24), ellipse(0.28, 0.52, 0.15, 0.14),
    ellipse(0.2, 0.8, 0.05, 0.22, 0.25), ellipse(0.3, 0.79, 0.05, 0.21, 0.4),
  ])),
  bunnyTail: new THREE.CircleGeometry(0.08, 14),
  bunnyHind: new THREE.ShapeGeometry(ellipse(0.02, -0.12, 0.17, 0.07)),
  bunnyFront: new THREE.ShapeGeometry(ellipse(0, -0.1, 0.04, 0.1)),
  penguinBody: centered(new THREE.ShapeGeometry([
    ellipse(0, 0.46, 0.3, 0.44), ellipse(0.06, 0.86, 0.17, 0.15), polygon([[0.18, 0.9], [0.38, 0.85], [0.18, 0.82]]),
  ])),
  penguinBelly: centered(new THREE.ShapeGeometry(ellipse(0.1, 0.42, 0.17, 0.32))),
  penguinFlipper: new THREE.ShapeGeometry(ellipse(0, -0.2, 0.05, 0.21)),
  penguinFoot: centered(new THREE.ShapeGeometry(ellipse(0.06, 0.02, 0.09, 0.03))),
  turtleBody: centered(new THREE.ShapeGeometry([
    polygon(shellArc), ellipse(0.68, 0.3, 0.16, 0.1), polygon([[-0.55, 0.26], [-0.74, 0.2], [-0.52, 0.2]]),
  ])),
  turtleLeg: limb(0.13, 0.24),
  slothBody: centered(new THREE.ShapeGeometry([ellipse(0, 0.5, 0.2, 0.3, -0.15), ellipse(0.1, 0.87, 0.14, 0.13)])),
  slothFace: centered(new THREE.ShapeGeometry(ellipse(0.15, 0.86, 0.09, 0.065))),
  slothLeg: limb(0.08, 0.28),
  slothArm: limb(0.07, 0.5),
  pole: new THREE.PlaneGeometry(0.05, 1).translate(0, 0.5, 0),
  // Flags hang from the pole top and trail behind the walker (toward -x).
  flag: new THREE.PlaneGeometry(1, 0.6, 12, 1).translate(-0.5, -0.3, 0),
};

const FLAG_VERT = /* glsl */ `
uniform float uPhase;
varying vec2 vUv;
varying float vShade;
void main() {
  vUv = uv;
  vec3 p = position;
  float along = -p.x; // 0 at the pole, 1 at the free end
  float w = along * 7.0 - uPhase;
  p.y += sin(w) * 0.07 * along;
  vShade = 0.75 + 0.25 * cos(w);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FLAG_FRAG = /* glsl */ `
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
varying vec2 vUv;
varying float vShade;
void main() {
  vec3 c = vUv.y > 0.667 ? uC1 : vUv.y > 0.333 ? uC2 : uC3;
  gl_FragColor = vec4(c * vShade, 1.0);
}`;

interface Mats {
  fill: THREE.MeshBasicMaterial;
  outline: THREE.MeshBasicMaterial;
  light: THREE.MeshBasicMaterial;
  eye: THREE.MeshBasicMaterial;
  bunnyEye: THREE.MeshBasicMaterial;
  flags: [THREE.ShaderMaterial, THREE.ShaderMaterial];
}

interface Runner {
  root: THREE.Group;
  animate(phase: number): void;
}

interface Pair {
  mats: Mats;
  wolf: Runner;
  bunny: Runner;
  penguin: Runner;
  turtle: Runner;
  sloth: Runner;
  lead: Runner;
  leadH: number;
  sizes: { penguin: number; turtle: number; sloth: number };
  band: Band;
  ground: number;
  active: boolean;
  parade: boolean;
  dir: 1 | -1;
  x: number;
  gap: number;
  speed: number;
  paradeX: number;
  age: number;
  tint: { fill: number; outline: THREE.Color; eyeHue: number; flags: THREE.Color[] };
}

const basicMat = () => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
const flagMat = () => new THREE.ShaderMaterial({
  vertexShader: FLAG_VERT,
  fragmentShader: FLAG_FRAG,
  uniforms: { uPhase: { value: 0 }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() } },
  transparent: true,
  depthTest: false,
  depthWrite: false,
  side: THREE.DoubleSide,
});

/**
 * Lightning Forest, plus a chase on every strike: a shadowy wolf (or, sometimes, a bunny) running
 * through the trees from a huge penguin, at a random depth in the forest. Optionally a turtle and a
 * sloth follow each chase, parading with colorful flags.
 */
export const createLightningChase: SceneFactory = (ctx) => {
  let paradeOn = false;
  const base = buildLightning(ctx, { onStrike: (_x, strength) => spawn(strength) });

  /** Meshes remember their draw-order offset within an animal; the band adds its base order on spawn. */
  const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, offset: number) => {
    const m = new THREE.Mesh(geo, material);
    m.userData.offset = offset;
    m.frustumCulled = false;
    return m;
  };

  /** A dark fill over a slightly larger, lighter copy: reads as a moonlit outline against dark trees. */
  const silhouette = (M: Mats, geo: THREE.BufferGeometry, at: Pt, offset = 0) => {
    const g = new THREE.Group();
    g.position.set(at[0], at[1], 0);
    const outline = mesh(geo, M.outline, offset);
    outline.scale.setScalar(OUTLINE_SCALE);
    g.add(outline, mesh(geo, M.fill, offset + 0.01));
    return g;
  };

  const makeWolf = (M: Mats): Runner => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    body.add(silhouette(M, GEO.wolfBody.geo, GEO.wolfBody.at));
    const eye = mesh(GEO.eye, M.eye, 0.04);
    eye.position.set(0.73, 0.86, 0);
    body.add(eye);
    const legs = ([[0.4, 0.5, 0], [0.3, 0.5, 0.5], [-0.46, 0.52, Math.PI], [-0.36, 0.52, Math.PI + 0.5]] as const).map(([x, y, ph]) => {
      const g = silhouette(M, GEO.wolfLeg, [x, y]);
      body.add(g);
      return { g, ph };
    });
    return {
      root,
      animate(phase) {
        body.position.y = Math.abs(Math.sin(phase)) * 0.06;
        body.rotation.z = Math.sin(phase) * 0.05;
        for (const l of legs) l.g.rotation.z = Math.sin(phase + l.ph) * 0.8;
      },
    };
  };

  const makeBunny = (M: Mats): Runner => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const hind = silhouette(M, GEO.bunnyHind, [-0.12, 0.2]);
    const front = silhouette(M, GEO.bunnyFront, [0.2, 0.2]);
    body.add(hind, front, silhouette(M, GEO.bunnyBody.geo, GEO.bunnyBody.at));
    const tail = mesh(GEO.bunnyTail, M.light, 0.02);
    tail.position.set(-0.36, 0.36, 0);
    const eye = mesh(GEO.smallEye, M.bunnyEye, 0.04);
    eye.position.set(0.34, 0.55, 0);
    body.add(tail, eye);
    return {
      root,
      animate(phase) {
        const hop = Math.abs(Math.sin(phase));
        body.position.y = hop * 0.45;
        body.rotation.z = -Math.sin(2 * phase) * 0.15;
        hind.rotation.z = -hop * 0.7;
        front.rotation.z = hop * 0.5;
      },
    };
  };

  const makePenguin = (M: Mats): Runner => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    body.add(silhouette(M, GEO.penguinBody.geo, GEO.penguinBody.at));
    const belly = mesh(GEO.penguinBelly.geo, M.light, 0.02);
    belly.position.set(GEO.penguinBelly.at[0], GEO.penguinBelly.at[1], 0);
    const flipper = silhouette(M, GEO.penguinFlipper, [-0.02, 0.7], 0.025);
    const eye = mesh(GEO.smallEye, M.eye, 0.04);
    eye.position.set(0.13, 0.9, 0);
    body.add(belly, flipper, eye);
    const foot = GEO.penguinFoot;
    const feet = [0.02, -0.12].map((dx) => {
      const g = silhouette(M, foot.geo, [foot.at[0] + dx, foot.at[1]]);
      root.add(g);
      return g;
    });
    return {
      root,
      animate(phase) {
        const s = Math.sin(phase);
        body.rotation.z = s * 0.14;
        body.position.y = 0.04 + Math.abs(s) * 0.05;
        flipper.rotation.z = -0.5 + Math.sin(phase * 2) * 0.7;
        feet[0].position.y = foot.at[1] + Math.max(0, s) * 0.07;
        feet[1].position.y = foot.at[1] + Math.max(0, -s) * 0.07;
      },
    };
  };

  const flagOn = (M: Mats, flag: THREE.ShaderMaterial, x: number, top: number, length: number) => {
    const pole = mesh(GEO.pole, M.outline, 0.005);
    pole.position.set(x, top - length, 0);
    pole.scale.set(1, length, 1);
    const cloth = mesh(GEO.flag, flag, 0.045);
    cloth.position.set(x, top, 0);
    cloth.scale.setScalar(0.9);
    return [pole, cloth];
  };

  const makeTurtle = (M: Mats): Runner => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    const legs = ([[0.32, 0], [0.18, Math.PI], [-0.2, Math.PI], [-0.34, 0]] as const).map(([x, ph]) => {
      const g = silhouette(M, GEO.turtleLeg, [x, 0.24]);
      root.add(g);
      return { g, ph };
    });
    root.add(body);
    body.add(silhouette(M, GEO.turtleBody.geo, GEO.turtleBody.at), ...flagOn(M, M.flags[0], -0.05, 2.65, 1.9));
    return {
      root,
      animate(phase) {
        body.position.y = Math.abs(Math.sin(phase)) * 0.03;
        for (const l of legs) l.g.rotation.z = Math.sin(phase + l.ph) * 0.35;
        M.flags[0].uniforms.uPhase.value = phase * 1.7;
      },
    };
  };

  const makeSloth = (M: Mats): Runner => {
    const root = new THREE.Group();
    const legs = ([[0.05, 0], [-0.06, Math.PI]] as const).map(([x, ph]) => {
      const g = silhouette(M, GEO.slothLeg, [x, 0.27]);
      root.add(g);
      return { g, ph };
    });
    const body = new THREE.Group();
    root.add(body);
    const hangingArm = silhouette(M, GEO.slothArm, [-0.05, 0.72]);
    const raisedArm = silhouette(M, GEO.slothArm, [0.08, 0.72], 0.005);
    raisedArm.rotation.z = Math.PI - 0.3; // pointing up and a little forward, holding the flag
    const face = mesh(GEO.slothFace.geo, M.light, 0.02);
    face.position.set(GEO.slothFace.at[0], GEO.slothFace.at[1], 0);
    body.add(hangingArm, silhouette(M, GEO.slothBody.geo, GEO.slothBody.at), face, raisedArm, ...flagOn(M, M.flags[1], 0.23, 2.2, 1.3));
    return {
      root,
      animate(phase) {
        body.rotation.z = Math.sin(phase) * 0.06;
        body.position.y = Math.abs(Math.sin(phase)) * 0.02;
        for (const l of legs) l.g.rotation.z = Math.sin(phase + l.ph) * 0.3;
        hangingArm.rotation.z = Math.sin(phase + Math.PI) * 0.25;
        M.flags[1].uniforms.uPhase.value = phase * 2.2;
      },
    };
  };

  const materials: THREE.Material[] = [];
  const pairs: Pair[] = Array.from({ length: POOL }, () => {
    const mats: Mats = {
      fill: basicMat(), outline: basicMat(), light: basicMat(), eye: basicMat(), bunnyEye: basicMat(),
      flags: [flagMat(), flagMat()],
    };
    materials.push(mats.fill, mats.outline, mats.light, mats.eye, mats.bunnyEye, ...mats.flags);
    const wolf = makeWolf(mats);
    const pair: Pair = {
      mats, wolf, bunny: makeBunny(mats), penguin: makePenguin(mats), turtle: makeTurtle(mats), sloth: makeSloth(mats),
      lead: wolf, leadH: H.wolf, sizes: { penguin: H.penguin, turtle: H.turtle, sloth: H.sloth },
      band: BANDS[2], ground: BANDS[2].ground, active: false, parade: false, dir: 1, x: 0, gap: 0, speed: 0, paradeX: 0, age: 0,
      tint: { fill: 1, outline: new THREE.Color(1, 1, 1), eyeHue: 0, flags: Array.from({ length: 6 }, () => new THREE.Color()) },
    };
    for (const r of [pair.wolf, pair.bunny, pair.penguin, pair.turtle, pair.sloth]) {
      r.root.visible = false;
      base.scene.add(r.root);
    }
    return pair;
  });

  const setOrder = (r: Runner, order: number) => {
    r.root.traverse((o) => { if (o instanceof THREE.Mesh) o.renderOrder = order + (o.userData.offset as number); });
  };

  function spawn(strength: number): void {
    const a = base.aspect();
    const p = pairs.find((q) => !q.active) ?? pairs.reduce((oldest, q) => (q.age > oldest.age ? q : oldest));
    const band = BANDS[Math.floor(Math.random() * BANDS.length)];
    const s = band.scale;
    p.band = band;
    p.ground = band.ground + rand(-0.015, 0.015) * s;
    const bunny = Math.random() < BUNNY_CHANCE;
    p.lead = bunny ? p.bunny : p.wolf;
    p.leadH = (bunny ? H.bunny : H.wolf) * s * rand(0.9, 1.1);
    p.sizes.penguin = H.penguin * s * rand(0.88, 1.12);
    p.sizes.turtle = H.turtle * s * rand(0.9, 1.1);
    p.sizes.sloth = H.sloth * s * rand(0.9, 1.1);
    p.dir = Math.random() < 0.5 ? 1 : -1;
    p.x = -p.dir * (a + 0.3);
    // Farther pairs cover less screen per second (parallax).
    p.speed = ((2 * a + 1.4) / CROSS_SECONDS) * (0.85 + 0.35 * strength) * rand(0.85, 1.15) * (0.5 + 0.5 * s);
    p.gap = rand(0.5, 0.8) * s;
    p.parade = paradeOn;
    p.paradeX = -p.dir * (a + 0.3 + 0.8 * s);
    p.age = 0;
    p.tint.fill = rand(0.8, 1.3);
    p.tint.outline.setRGB(rand(0.88, 1.12), rand(0.88, 1.12), rand(0.88, 1.12));
    p.tint.eyeHue = rand(-0.05, 0.05);
    for (let f = 0; f < 2; f++) {
      const hue = Math.random();
      for (let k = 0; k < 3; k++) p.tint.flags[f * 3 + k].setHSL((hue + k / 3 + rand(-0.04, 0.04)) % 1, 0.85, 0.55);
    }
    for (const r of [p.wolf, p.bunny, p.penguin, p.turtle, p.sloth]) setOrder(r, band.order);
    p.wolf.root.visible = !bunny;
    p.bunny.root.visible = bunny;
    p.penguin.root.visible = true;
    p.turtle.root.visible = p.sloth.root.visible = p.parade;
    p.active = true;
  }

  const place = (r: Runner, x: number, ground: number, height: number, dir: number, phase: number) => {
    r.root.position.set(x, ground, 0);
    r.root.scale.set(dir * height, height, 1);
    r.animate(phase);
  };

  const fog = new THREE.Color();
  const tmp = new THREE.Color();

  const colorPair = (p: Pair, i: ForestInputs, flash: number) => {
    const near = p.band.near;
    const M = p.mats;
    fog.setRGB(0.02, 0.026, 0.045).multiplyScalar(0.6 + i.light * 0.8);
    // Farther animals sink into the fog.
    M.fill.color.copy(DARK).multiplyScalar(p.tint.fill).lerp(tmp.copy(fog).multiplyScalar(1.1), 0.6 * (1 - near)).multiplyScalar(i.intensity);
    tmp.copy(i.colorC).multiplyScalar(flash * 0.9 * (0.4 + 0.6 * near));
    M.outline.color.copy(fog).multiplyScalar(1.1 + 0.9 * near).multiply(p.tint.outline).add(tmp).multiplyScalar(i.intensity);
    M.light.color.copy(LIGHT).multiplyScalar(p.tint.fill).addScalar(flash * 0.2).lerp(tmp.copy(fog).multiplyScalar(1.1), 0.5 * (1 - near)).multiplyScalar(i.intensity);
    M.eye.color.copy(i.colorB).offsetHSL(p.tint.eyeHue, 0, 0).multiplyScalar(2.5 * (0.35 + 0.65 * near) * i.intensity);
    M.bunnyEye.color.setRGB(0.35, 0.12, 0.18).multiplyScalar((0.5 + 0.5 * near) * i.intensity);
    if (p.parade) {
      const glow = (0.5 + 0.7 * near) * i.intensity;
      for (let f = 0; f < 2; f++) {
        const u = M.flags[f].uniforms;
        (u.uC1.value as THREE.Color).copy(p.tint.flags[f * 3]).multiplyScalar(glow);
        (u.uC2.value as THREE.Color).copy(p.tint.flags[f * 3 + 1]).multiplyScalar(glow);
        (u.uC3.value as THREE.Color).copy(p.tint.flags[f * 3 + 2]).multiplyScalar(glow);
      }
    }
  };

  return {
    scene: base.scene,
    camera: base.camera,
    update(i) {
      paradeOn = i.parade;
      base.update(i);
      const a = base.aspect();
      const flash = base.flash();
      const dt = i.realDt;
      for (const p of pairs) {
        if (!p.active) continue;
        p.age += dt;
        const s = p.band.scale;
        p.x += p.dir * p.speed * dt;
        p.gap = Math.max(0.3 * s, p.gap - dt * 0.03 * s); // the penguin slowly gains
        const chaserX = p.x - p.dir * p.gap;
        const chaseDone = p.dir * chaserX > a + 0.5;
        if (!chaseDone) {
          place(p.lead, p.x, p.ground, p.leadH, p.dir, p.age * Math.PI * 2 * (p.lead === p.bunny ? 1.4 : 3.2));
          place(p.penguin, chaserX, p.ground, p.sizes.penguin, p.dir, p.age * Math.PI * 2 * 2.4);
        }
        p.lead.root.visible = p.penguin.root.visible = !chaseDone;

        let paradeDone = true;
        if (p.parade && paradeOn) {
          p.paradeX += p.dir * p.speed * PARADE_SPEED * dt;
          const slothX = p.paradeX - p.dir * 0.35 * s;
          paradeDone = p.dir * slothX > a + 0.5;
          place(p.turtle, p.paradeX, p.ground, p.sizes.turtle, p.dir, p.age * Math.PI * 2 * 0.9);
          place(p.sloth, slothX, p.ground, p.sizes.sloth, p.dir, p.age * Math.PI * 2 * 0.6);
        }
        p.turtle.root.visible = p.sloth.root.visible = p.parade && paradeOn && !paradeDone;

        if (chaseDone && paradeDone) {
          p.active = false;
          continue;
        }
        colorPair(p, i, flash);
      }
    },
    resize(w, h) {
      base.resize(w, h);
    },
    dispose() {
      base.dispose();
      for (const m of materials) m.dispose();
      // GEO is shared module-level geometry; it lives as long as the page.
    },
  };
};
