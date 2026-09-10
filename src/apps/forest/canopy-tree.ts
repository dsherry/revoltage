import * as THREE from 'three';

export const MAX_TREES = 7;

export interface TreeInfo {
  /** Index of the base node (at the ground, local (0, 0)). */
  base: number;
  /** Longest base → twig path; growth order = dist / maxDist. */
  maxDist: number;
  twigTips: number[];
  rootTips: number[];
  scale: number;
  phase: number;
  rate: number;
  jitter: number;
}

/**
 * All trees, generated once. Node coordinates are local to each tree (base at (0, 0), y up, roots y < 0);
 * the shaders place, scale and sway them per tree.
 */
export interface ForestModel {
  nodeX: Float32Array;
  nodeY: Float32Array;
  nodeDist: Float32Array;
  nodeSway: Float32Array;
  nodeParent: Int32Array;
  trees: TreeInfo[];
  branches: THREE.BufferGeometry;
  leaves: THREE.BufferGeometry;
}

interface Chain { tree: number; nodes: number[]; widths: number[] }

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HALF_PI = Math.PI / 2;
const LEAF_STRIDE = 8; // x, y, node, angle, size, order offset, seed, tree

export function buildForest(seed: number): ForestModel {
  const rng = mulberry32(seed);
  const rand = (lo: number, hi: number) => lo + (hi - lo) * rng();
  const nx: number[] = [], ny: number[] = [], nd: number[] = [], np: number[] = [];
  const nRoot: boolean[] = [], nTree: number[] = [];
  const chains: Chain[] = [];
  const leaves: number[] = [];
  const trees: TreeInfo[] = [];

  for (let k = 0; k < MAX_TREES; k++) {
    const info: TreeInfo = {
      base: 0, maxDist: 1, twigTips: [], rootTips: [],
      scale: rand(0.9, 1.06), phase: rand(0, Math.PI * 2), rate: rand(0.9, 1.1), jitter: rand(-0.035, 0.035),
    };
    const depthMax = rng() < 0.55 ? 7 : 6;
    const leafSize = rand(9, 12);

    const addNode = (x: number, y: number, d: number, parent: number, root: boolean): number => {
      nx.push(x); ny.push(y); nd.push(d); np.push(parent); nRoot.push(root); nTree.push(k);
      return nx.length - 1;
    };
    const addLeaf = (x: number, y: number, node: number, angle: number, size: number): void => {
      leaves.push(x + rand(-0.018, 0.018), y + rand(-0.015, 0.015), node, angle, size, rand(0.01, 0.05), rng(), k);
    };

    const grow = (parent: number, angle: number, len: number, w: number, depth: number): void => {
      const segs = depth === 0 ? 6 : depth === 1 ? 4 : depth >= depthMax - 1 ? 2 : 3;
      const segLen = len / segs;
      const wiggle = depth === 0 ? 0.07 : 0.17;
      const chain: Chain = { tree: k, nodes: [parent], widths: [w] };
      chains.push(chain);
      let x = nx[parent], y = ny[parent], d = nd[parent], a = angle, prev = parent;
      for (let s = 1; s <= segs; s++) {
        a += rand(-wiggle, wiggle);
        a += (HALF_PI - a) * (depth === 0 ? 0.12 : 0.06); // gentle upward tendency
        const px = x, py = y;
        x += Math.cos(a) * segLen;
        y = Math.max(0.03, y + Math.sin(a) * segLen);
        d += Math.hypot(x - px, y - py);
        prev = addNode(x, y, d, prev, false);
        chain.nodes.push(prev);
        chain.widths.push(w * (1 - 0.3 * s / segs));
        if (depth >= depthMax - 1 && rng() < 0.7) addLeaf(x, y, prev, a + rand(-1.2, 1.2), leafSize * rand(0.7, 1.1));
        if (depth <= 1 && s >= 2 && s < segs && rng() < 0.35) {
          const side = rng() < 0.5 ? -1 : 1;
          grow(prev, a + side * rand(0.7, 1.1), len * rand(0.4, 0.55), w * 0.45, depth + 2);
        }
      }
      if (depth >= depthMax) {
        info.twigTips.push(prev);
        for (let j = 0; j < 3; j++) addLeaf(x, y, prev, a + (j - 1) * 0.7 + rand(-0.3, 0.3), leafSize * rand(0.8, 1.2));
        return;
      }
      const wEnd = w * 0.7;
      const spread = rand(0.35, 0.6);
      if (depth < 4 && rng() < 0.3) {
        grow(prev, a - spread, len * rand(0.62, 0.72), wEnd * 0.72, depth + 1);
        grow(prev, a + rand(-0.12, 0.12), len * rand(0.74, 0.82), wEnd * 0.85, depth + 1);
        grow(prev, a + spread, len * rand(0.62, 0.72), wEnd * 0.72, depth + 1);
      } else {
        const side = rng() < 0.5 ? -1 : 1;
        grow(prev, a + side * spread * 0.4, len * rand(0.74, 0.82), wEnd * 0.88, depth + 1);
        grow(prev, a - side * spread * rand(1.0, 1.4), len * rand(0.6, 0.72), wEnd * 0.7, depth + 1);
      }
    };

    const rootGrow = (parent: number, angle: number, len: number, w: number, depth: number): void => {
      const segs = 3;
      const segLen = len / segs;
      const chain: Chain = { tree: k, nodes: [parent], widths: [w] };
      chains.push(chain);
      let x = nx[parent], y = ny[parent], d = nd[parent], a = angle, prev = parent;
      for (let s = 1; s <= segs; s++) {
        a += rand(-0.25, 0.25);
        a += (-HALF_PI - a) * 0.05;
        const px = x, py = y;
        x += Math.cos(a) * segLen;
        y = Math.min(-0.008, y + Math.sin(a) * segLen);
        d += Math.hypot(x - px, y - py);
        prev = addNode(x, y, d, prev, true);
        chain.nodes.push(prev);
        chain.widths.push(w * (1 - 0.35 * s / segs));
      }
      if (depth >= 3) {
        info.rootTips.push(prev);
        return;
      }
      const spread = rand(0.3, 0.6);
      rootGrow(prev, a - spread, len * rand(0.6, 0.75), w * 0.6, depth + 1);
      rootGrow(prev, a + spread, len * rand(0.6, 0.75), w * 0.6, depth + 1);
    };

    const start = nx.length;
    info.base = addNode(0, 0, 0, -1, false);
    const trunkW = rand(0.018, 0.024);
    grow(info.base, HALF_PI + rand(-0.1, 0.1), rand(0.24, 0.28), trunkW, 0);
    const nRoots = 3 + Math.floor(rng() * 3);
    for (let r = 0; r < nRoots; r++) {
      const a = -HALF_PI + ((r + 0.5) / nRoots - 0.5) * 2.4 + rand(-0.15, 0.15);
      rootGrow(info.base, a, rand(0.09, 0.14), trunkW * rand(0.4, 0.6), 0);
    }
    let maxDist = 0.01;
    for (let i = start; i < nx.length; i++) if (!nRoot[i]) maxDist = Math.max(maxDist, nd[i]);
    info.maxDist = maxDist;
    trees.push(info);
  }

  const count = nx.length;
  const nodeSway = new Float32Array(count);
  const order = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const md = trees[nTree[i]].maxDist;
    order[i] = nd[i] / md;
    nodeSway[i] = nRoot[i] ? 0 : Math.pow(nd[i] / md, 1.4);
  }

  return {
    nodeX: Float32Array.from(nx),
    nodeY: Float32Array.from(ny),
    nodeDist: Float32Array.from(nd),
    nodeSway,
    nodeParent: Int32Array.from(np),
    trees,
    branches: branchGeometry(chains, nx, ny, order, nodeSway),
    leaves: leafGeometry(leaves, order, nodeSway),
  };
}

/** Each chain becomes a ribbon strip: two vertices per node, offset sideways in the vertex shader. */
function branchGeometry(chains: Chain[], nx: number[], ny: number[], order: Float32Array, sway: Float32Array): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const c of chains) { nv += c.nodes.length * 2; ni += (c.nodes.length - 1) * 6; }
  const pos = new Float32Array(nv * 3);
  const info = new Float32Array(nv * 4); // order, tree, sway, side
  const nw = new Float32Array(nv * 3); // normal.xy, half width
  const index = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let v = 0, ii = 0;
  for (const c of chains) {
    const m = c.nodes.length;
    const v0 = v;
    for (let i = 0; i < m; i++) {
      const node = c.nodes[i];
      const a = c.nodes[Math.max(i - 1, 0)], b = c.nodes[Math.min(i + 1, m - 1)];
      const tx = nx[b] - nx[a], ty = ny[b] - ny[a];
      const l = Math.hypot(tx, ty) || 1;
      for (let side = -1; side <= 1; side += 2) {
        pos[v * 3] = nx[node]; pos[v * 3 + 1] = ny[node]; pos[v * 3 + 2] = 0;
        info[v * 4] = order[node]; info[v * 4 + 1] = c.tree; info[v * 4 + 2] = sway[node]; info[v * 4 + 3] = side;
        nw[v * 3] = -ty / l; nw[v * 3 + 1] = tx / l; nw[v * 3 + 2] = c.widths[i];
        v++;
      }
    }
    for (let i = 0; i < m - 1; i++) {
      const a = v0 + i * 2;
      index[ii++] = a; index[ii++] = a + 1; index[ii++] = a + 2;
      index[ii++] = a + 1; index[ii++] = a + 3; index[ii++] = a + 2;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geo.setAttribute('aNW', new THREE.BufferAttribute(nw, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  return geo;
}

function leafGeometry(leaves: number[], order: Float32Array, sway: Float32Array): THREE.BufferGeometry {
  const n = leaves.length / LEAF_STRIDE;
  const pos = new Float32Array(n * 3);
  const info = new Float32Array(n * 4); // order, tree, sway, seed
  const leaf = new Float32Array(n * 2); // angle, size (px at 1080p)
  for (let i = 0; i < n; i++) {
    const o = i * LEAF_STRIDE;
    const node = leaves[o + 2];
    pos[i * 3] = leaves[o]; pos[i * 3 + 1] = leaves[o + 1]; pos[i * 3 + 2] = 0;
    info[i * 4] = order[node] + leaves[o + 5];
    info[i * 4 + 1] = leaves[o + 7];
    info[i * 4 + 2] = sway[node];
    info[i * 4 + 3] = leaves[o + 6];
    leaf[i * 2] = leaves[o + 3];
    leaf[i * 2 + 1] = leaves[o + 4];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
  geo.setAttribute('aLeaf', new THREE.BufferAttribute(leaf, 2));
  return geo;
}
