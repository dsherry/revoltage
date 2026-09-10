import * as THREE from 'three';
import type { SceneFactory } from './types';
import { buildLightning, LAYERS, ORDER } from './lightning';

// Runners cross on pine layer 2's ground: in front of its trees, behind the front layer's.
const GROUND = LAYERS[2].ground;
const RUN_ORDER = ORDER.mask + 0.5;
const POOL = 6;
const WOLF_H = 0.13;
const PENGUIN_H = 0.4;
const CROSS_SECONDS = 3.4;
const OUTLINE_SCALE = 1.1;

type Pt = [number, number];

const polygon = (pts: Pt[]): THREE.Shape => {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) s.lineTo(pts[k][0], pts[k][1]);
  s.closePath();
  return s;
};

const ellipse = (cx: number, cy: number, rx: number, ry: number): THREE.Shape => {
  const s = new THREE.Shape();
  s.absellipse(cx, cy, rx, ry, 0, Math.PI * 2, false, 0);
  return s;
};

/** Geometry centered on its bounding box, plus where that center sits in the runner's coordinates. */
function centered(geo: THREE.BufferGeometry): { geo: THREE.BufferGeometry; at: Pt } {
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  geo.translate(-c.x, -c.y, 0);
  return { geo, at: [c.x, c.y] };
}

// Runner shapes face +x with feet at y = 0, in units of the runner's height.
const WOLF_BODY: Pt[] = [
  [-0.95, 0.56], [-0.7, 0.66], [-0.35, 0.72], [0.1, 0.7], [0.32, 0.75], [0.46, 0.84], [0.56, 0.94], [0.6, 1.0],
  [0.66, 0.93], [0.72, 0.9], [0.9, 0.83], [0.95, 0.77], [0.8, 0.72], [0.64, 0.66], [0.52, 0.5], [0.3, 0.45],
  [0.0, 0.44], [-0.35, 0.46], [-0.5, 0.5], [-0.68, 0.55], [-0.93, 0.51],
];
// Leg pivots (hip/shoulder) and gallop phase offsets.
const WOLF_LEGS: [number, number, number][] = [[0.4, 0.5, 0], [0.3, 0.5, 0.5], [-0.46, 0.52, Math.PI], [-0.36, 0.52, Math.PI + 0.5]];

interface Runner {
  root: THREE.Group;
  animate(phase: number): void;
}

interface Pair {
  wolf: Runner;
  penguin: Runner;
  active: boolean;
  dir: 1 | -1;
  x: number;
  gap: number;
  speed: number;
  lift: number;
  time: number;
}

/** Lightning Forest, plus a shadowy wolf chased by a huge penguin across the forest on every strike. */
export const createLightningChase: SceneFactory = (ctx) => {
  const base = buildLightning(ctx, { onStrike: (_x, strength) => spawn(strength) });

  const mat = () => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const M = { fill: mat(), outline: mat(), belly: mat(), wolfEye: mat(), penguinEye: mat() };

  const wolfBody = centered(new THREE.ShapeGeometry(polygon(WOLF_BODY)));
  const wolfLeg = new THREE.PlaneGeometry(0.075, 0.5).translate(0, -0.25, 0);
  const wolfEye = new THREE.CircleGeometry(0.03, 12);
  const penguinBody = centered(new THREE.ShapeGeometry([
    ellipse(0, 0.46, 0.3, 0.44),
    ellipse(0.06, 0.86, 0.17, 0.15),
    polygon([[0.18, 0.9], [0.38, 0.85], [0.18, 0.82]]),
  ]));
  const penguinBelly = centered(new THREE.ShapeGeometry(ellipse(0.1, 0.42, 0.17, 0.32)));
  const penguinFlipper = new THREE.ShapeGeometry(ellipse(0, -0.2, 0.05, 0.21));
  const penguinFoot = centered(new THREE.ShapeGeometry(ellipse(0.06, 0.02, 0.09, 0.03)));
  const penguinEye = new THREE.CircleGeometry(0.025, 12);
  const geometries = [wolfBody.geo, wolfLeg, wolfEye, penguinBody.geo, penguinBelly.geo, penguinFlipper, penguinFoot.geo, penguinEye];

  const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, order: number) => {
    const m = new THREE.Mesh(geo, material);
    m.renderOrder = order;
    m.frustumCulled = false;
    return m;
  };

  /** A dark fill over a slightly larger, lighter copy: reads as a moonlit outline against dark trees. */
  const silhouette = (geo: THREE.BufferGeometry, at: Pt, order = RUN_ORDER) => {
    const g = new THREE.Group();
    g.position.set(at[0], at[1], 0);
    const outline = mesh(geo, M.outline, order);
    outline.scale.setScalar(OUTLINE_SCALE);
    g.add(outline, mesh(geo, M.fill, order + 0.01));
    return g;
  };

  const makeWolf = (): Runner => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    body.add(silhouette(wolfBody.geo, wolfBody.at));
    const eye = mesh(wolfEye, M.wolfEye, RUN_ORDER + 0.04);
    eye.position.set(0.73, 0.86, 0);
    body.add(eye);
    const legs = WOLF_LEGS.map(([x, y, ph]) => {
      const g = silhouette(wolfLeg, [x, y]);
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

  const makePenguin = (): Runner => {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    body.add(silhouette(penguinBody.geo, penguinBody.at));
    const belly = mesh(penguinBelly.geo, M.belly, RUN_ORDER + 0.02);
    belly.position.set(penguinBelly.at[0], penguinBelly.at[1], 0);
    body.add(belly);
    const flipper = silhouette(penguinFlipper, [-0.02, 0.7], RUN_ORDER + 0.025);
    body.add(flipper);
    const eye = mesh(penguinEye, M.penguinEye, RUN_ORDER + 0.04);
    eye.position.set(0.13, 0.9, 0);
    body.add(eye);
    const feet = [0.02, -0.12].map((dx) => {
      const g = silhouette(penguinFoot.geo, [penguinFoot.at[0] + dx, penguinFoot.at[1]]);
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
        feet[0].position.y = penguinFoot.at[1] + Math.max(0, s) * 0.07;
        feet[1].position.y = penguinFoot.at[1] + Math.max(0, -s) * 0.07;
      },
    };
  };

  const pairs: Pair[] = Array.from({ length: POOL }, () => {
    const wolf = makeWolf();
    const penguin = makePenguin();
    for (const r of [wolf, penguin]) {
      r.root.visible = false;
      base.scene.add(r.root);
    }
    return { wolf, penguin, active: false, dir: 1, x: 0, gap: 0, speed: 0, lift: 0, time: 0 };
  });

  function spawn(strength: number): void {
    const a = base.aspect();
    // A free pair, or else the one furthest across the screen.
    let slot = pairs.find((p) => !p.active);
    if (!slot) slot = pairs.reduce((best, p) => (p.dir * p.x > best.dir * best.x ? p : best));
    slot.dir = Math.random() < 0.5 ? 1 : -1;
    slot.gap = 0.5 + Math.random() * 0.3;
    slot.x = -slot.dir * (a + 0.3);
    slot.speed = ((2 * a + 1.4) / CROSS_SECONDS) * (0.85 + 0.35 * strength);
    slot.lift = (Math.random() - 0.5) * 0.04;
    slot.time = Math.random() * 2;
    slot.active = true;
    slot.wolf.root.visible = true;
    slot.penguin.root.visible = true;
  }

  const place = (r: Runner, x: number, height: number, dir: number, phase: number, lift: number) => {
    r.root.position.set(x, GROUND + lift, 0);
    r.root.scale.set(dir * height, height, 1);
    r.animate(phase);
  };

  const flashTint = new THREE.Color();

  return {
    scene: base.scene,
    camera: base.camera,
    update(i) {
      base.update(i);
      const a = base.aspect();
      const flash = base.flash();

      M.fill.color.setRGB(0.002, 0.0025, 0.004).multiplyScalar(i.intensity);
      flashTint.copy(i.colorC).multiplyScalar(flash * 0.9);
      M.outline.color.setRGB(0.02, 0.026, 0.045).multiplyScalar(0.6 + i.light * 0.8).add(flashTint).multiplyScalar(i.intensity);
      M.belly.color.setRGB(0.018, 0.02, 0.026).addScalar(flash * 0.2).multiplyScalar(i.intensity);
      M.wolfEye.color.copy(i.colorB).multiplyScalar(2.5 * i.intensity);
      M.penguinEye.color.setRGB(0.25, 0.25, 0.3).multiplyScalar(i.intensity);

      for (const p of pairs) {
        if (!p.active) continue;
        p.time += i.realDt;
        p.x += p.dir * p.speed * i.realDt;
        p.gap = Math.max(0.3, p.gap - i.realDt * 0.03); // the penguin slowly gains
        const penguinX = p.x - p.dir * p.gap;
        place(p.wolf, p.x, WOLF_H, p.dir, p.time * Math.PI * 2 * 3.2, p.lift);
        place(p.penguin, penguinX, PENGUIN_H, p.dir, p.time * Math.PI * 2 * 2.4, p.lift);
        if (p.dir * penguinX > a + 0.5) {
          p.active = false;
          p.wolf.root.visible = false;
          p.penguin.root.visible = false;
        }
      }
    },
    resize(w, h) {
      base.resize(w, h);
    },
    dispose() {
      base.dispose();
      for (const g of geometries) g.dispose();
      for (const m of Object.values(M)) m.dispose();
    },
  };
};
