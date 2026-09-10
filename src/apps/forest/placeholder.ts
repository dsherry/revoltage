import * as THREE from 'three';
import type { ForestScene, SceneContext } from './types';

/** Temporary scene: a slowly turning ring of points in the scene's colors. */
export function placeholderScene(_ctx: SceneContext, label: string): ForestScene {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  const n = 400;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.set([Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false });
  const points = new THREE.Points(geo, mat);
  points.name = label;
  scene.add(points);
  let aspect = 1;
  return {
    scene,
    camera,
    update(i) {
      points.rotation.z = i.t * 0.2;
      points.scale.setScalar(1 + i.bass * 0.3);
      mat.color.copy(i.onset ? i.colorC : i.colorA).multiplyScalar(i.intensity);
      camera.left = -aspect; camera.right = aspect; camera.updateProjectionMatrix();
    },
    resize(w, h) { aspect = w / h; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
