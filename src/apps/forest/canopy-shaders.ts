import { MAX_TREES } from './canopy-tree';

export const FLASHES = 16;

// GLSL1-style ShaderMaterial source (three converts it to GLSL 3.00 and defines gl_FragColor).

/** Per-tree placement + sway, shared by branches, leaves and pulses so they move together. */
const TREE = `
uniform vec4 uTree[${MAX_TREES}];  // x, scale, visibility, growth
uniform vec4 uTreeB[${MAX_TREES}]; // energy, sway phase, -, -
uniform float uTime;
uniform float uGround;
uniform float uSwayAmp;
uniform float uNod;

vec2 treeWorld(vec2 p, int k, float sway) {
  vec4 T = uTree[k];
  float ph = uTreeB[k].y;
  float s = 0.7 * sin(uTime * 0.55 + ph + p.y * 1.3) + 0.3 * sin(uTime * 1.21 + ph * 2.3 + p.y * 2.9);
  p.x += sway * (uSwayAmp * s + uNod * sin(ph * 3.0 + uTime * 0.05));
  return vec2(T.x + p.x * T.y, uGround + p.y * T.y);
}`;

export const BG_VERT = `
uniform float uAspect;
varying vec2 vP;
void main() {
  vP = position.xy * vec2(uAspect, 1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const BG_FRAG = `
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec2 uSun;
uniform float uSunR;
uniform float uLight;
uniform float uIntensity;
uniform float uGround;
uniform float uGroundGlow;
uniform float uBass;
uniform float uTime;
uniform float uAspect;
varying vec2 vP;
void main() {
  vec2 p = vP;
  float up = smoothstep(uGround, 1.0, p.y);
  vec3 col = vec3(0.003, 0.006, 0.009) + uColA * 0.008 * (1.0 - up) + uColB * 0.018 * uLight * up;

  // Sun: haze, slow faint rays, corona and core. Integer ray frequencies keep atan's wrap seamless.
  vec2 dv = p - uSun;
  float d = length(dv);
  float ang = atan(dv.y, dv.x + 1e-5); // offset avoids atan(0, 0) (a NaN would smear through bloom)
  float rays = pow(0.5 + 0.5 * sin(ang * 7.0 + uTime * 0.04), 6.0)
    + 0.6 * pow(0.5 + 0.5 * sin(ang * 11.0 - uTime * 0.03), 6.0);
  float above = smoothstep(uGround - 0.02, uGround + 0.1, p.y);
  col += uColB * uLight * (0.045 * exp(-d * 2.5) + 0.035 * rays * exp(-d * 1.4)) * above;
  col += uColB * (0.04 + 0.7 * uLight) * exp(-d * 16.0);
  col += mix(uColB, vec3(1.0), 0.5) * (1.0 - smoothstep(uSunR * 0.55, uSunR, d)) * (0.15 + 3.0 * uLight);

  // Soil below the ground line.
  float below = 1.0 - smoothstep(uGround - 0.015, uGround + 0.005, p.y);
  col = mix(col, vec3(0.002, 0.003, 0.004) + uColA * 0.004, below * 0.85);

  // Ground glow band (bass).
  float dy = p.y - uGround;
  float wav = 0.7 + 0.3 * sin(p.x * 3.1 + uTime * 0.3) * sin(p.x * 1.7 - uTime * 0.21 + 1.3);
  float band = 0.35 * exp(-abs(dy) * 14.0) + 0.9 * exp(-abs(dy) * 110.0);
  col += mix(uColA, uColC, 0.25 + 0.35 * clamp(uBass, 0.0, 1.0)) * band * wav * uGroundGlow;

  float vig = 1.0 - 0.4 * smoothstep(0.7, 1.5, length(p / vec2(uAspect, 1.0)));
  gl_FragColor = vec4(col * uIntensity * vig, 1.0);
}`;

export const BRANCH_VERT = `
${TREE}
uniform float uPx;
attribute vec4 aInfo; // order, tree, sway, side
attribute vec3 aNW;   // normal.xy, half width
varying float vOrder;
varying float vSide;
varying float vHalfPx;
varying float vCover;
varying float vLocalY;
varying float vTree;
void main() {
  int k = int(aInfo.y + 0.5);
  vec4 T = uTree[k];
  // Freshly grown wood is thin and thickens as growth moves past it.
  float grown = clamp((T.w - aInfo.x) * 7.0 + 0.3, 0.3, 1.0);
  float hw = aNW.z * T.y * grown;
  // Keep at least ~1.5 px width so thin twigs don't break up; fade them instead.
  float hwDraw = max(hw, uPx * 0.75);
  vec2 w = treeWorld(position.xy, k, aInfo.z) + aNW.xy * hwDraw * aInfo.w;
  vOrder = aInfo.x;
  vSide = aInfo.w;
  vHalfPx = hwDraw / uPx;
  vCover = hw / hwDraw;
  vLocalY = position.y;
  vTree = aInfo.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 0.0, 1.0);
}`;

export const BRANCH_FRAG = `
uniform vec4 uTree[${MAX_TREES}];
uniform vec4 uTreeB[${MAX_TREES}];
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform float uTime;
uniform float uIntensity;
uniform float uLevel;
uniform float uBass;
uniform float uLight;
varying float vOrder;
varying float vSide;
varying float vHalfPx;
varying float vCover;
varying float vLocalY;
varying float vTree;
void main() {
  int k = int(vTree + 0.5);
  vec4 T = uTree[k];
  float behind = T.w - vOrder;
  if (behind < 0.0) discard;
  float side = abs(vSide);
  float edge = clamp((1.0 - side) * vHalfPx, 0.0, 1.0);
  float root = 1.0 - smoothstep(-0.03, 0.0, vLocalY);
  float s2 = side * side;
  vec3 col = uColA * (0.06 + 0.1 * s2 * s2) + uColB * 0.012;
  // Sap flowing down from the canopy (the sun feeds the tree).
  float sap = pow(0.5 + 0.5 * sin(vOrder * 70.0 + uTime * 2.2 + vTree * 1.7), 8.0);
  col += uColA * sap * (1.0 - side) * (0.06 + 0.4 * uLevel) * (0.5 + 0.5 * uLight) * (1.0 - root);
  // Roots drink the bass.
  col += mix(uColA, uColC, 0.5) * root * (0.03 + 0.6 * uBass) * exp(vLocalY * 5.0);
  // Glowing growth front.
  col += mix(uColB, vec3(1.0), 0.35) * exp(-behind * 45.0) * 1.6;
  col += uColC * uTreeB[k].x * 0.22;
  gl_FragColor = vec4(col * uIntensity, edge * vCover * T.z);
}`;

export const LEAF_VERT = `
${TREE}
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec2 uSun;
uniform float uLight;
uniform float uIntensity;
uniform float uPxScale;
uniform float uTreble;
uniform float uMid;
uniform float uRealTime;
uniform vec4 uFlash[${FLASHES}]; // local x, y, tree, strength
attribute vec4 aInfo; // order, tree, sway, seed
attribute vec2 aLeaf; // angle, size
varying vec3 vCol;
varying vec2 vRot;
void main() {
  int k = int(aInfo.y + 0.5);
  vec4 T = uTree[k];
  float appear = smoothstep(aInfo.x, aInfo.x + 0.04, T.w) * T.z;
  if (appear < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    vCol = vec3(0.0);
    vRot = vec2(1.0, 0.0);
    return;
  }
  float seed = aInfo.w;
  vec2 p = position.xy;
  p += vec2(sin(uTime * (1.3 + seed) + seed * 40.0), cos(uTime * (1.1 + seed) + seed * 23.0)) * 0.003 * aInfo.z;
  vec2 w = treeWorld(p, k, aInfo.z);

  float d = distance(w, uSun);
  float sun = uLight * (0.15 + 0.85 * exp(-d * d * 2.2));

  float fl = 0.0;
  for (int i = 0; i < ${FLASHES}; i++) {
    vec4 F = uFlash[i];
    vec2 dd = position.xy - F.xy;
    fl += F.w * step(abs(F.z - aInfo.y), 0.5) * exp(-dot(dd, dd) * 120.0);
  }

  float shimmer = 1.0 + (0.12 + 0.5 * uTreble) * sin(uRealTime * (3.0 + 5.0 * seed) + seed * 60.0);
  vec3 c = mix(uColA, uColB, sun) * (0.24 + 0.9 * sun) * shimmer * (1.0 + 0.3 * uMid);
  c += uColC * uTreeB[k].x * 0.12;
  c += mix(uColC, vec3(1.0), 0.3) * fl * 2.5;
  vCol = c * uIntensity * appear;

  float ang = aLeaf.x + 0.15 * sin(uTime * 0.8 + seed * 10.0);
  vRot = vec2(cos(ang), sin(ang));
  gl_PointSize = aLeaf.y * uPxScale * T.y * (0.25 + 0.75 * appear) * (1.0 + 0.5 * min(fl, 1.0));
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 0.0, 1.0);
}`;

export const LEAF_FRAG = `
varying vec3 vCol;
varying vec2 vRot;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  vec2 r = vec2(dot(q, vRot), dot(q, vec2(-vRot.y, vRot.x)));
  float e = r.x * r.x + r.y * r.y * 5.0; // almond, long along the leaf's axis
  if (e > 1.0) discard;
  float a = 1.0 - e;
  gl_FragColor = vec4(vCol * (0.25 + 0.75 * a * a), 1.0);
}`;

export const PULSE_VERT = `
${TREE}
uniform float uPxScale;
attribute vec4 aInfo; // tree, sway, brightness, size
varying float vB;
void main() {
  int k = int(aInfo.x + 0.5);
  vec2 w = treeWorld(position.xy, k, aInfo.y);
  vB = aInfo.z;
  gl_PointSize = aInfo.w * uPxScale;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 0.0, 1.0);
}`;

export const PULSE_FRAG = `
uniform vec3 uColC;
uniform float uIntensity;
varying float vB;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(q, q);
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 4.0);
  vec3 c = mix(uColC, vec3(1.0), clamp(vB * 0.2, 0.0, 0.6)) * vB;
  gl_FragColor = vec4(c * a * uIntensity, 1.0);
}`;

export const FLY_VERT = `
uniform float uTime;
uniform float uRealTime;
uniform float uAspect;
uniform float uGround;
uniform float uTreble;
uniform float uPxScale;
uniform float uLife;
uniform vec2 uHand;
uniform float uHandAmt;
attribute vec4 aSeed;
varying float vB;
void main() {
  vec4 s = aSeed;
  float t = uTime;
  float wrap = uAspect * 1.15;
  float dir = s.y > 0.5 ? 1.0 : -1.0;
  float x = mod((s.x * 2.0 - 1.0) * wrap + t * (0.006 + 0.012 * s.w) * dir + wrap, 2.0 * wrap) - wrap;
  float y = mix(uGround - 0.04, 0.85, pow(s.y, 1.4));
  x += 0.12 * sin(t * (0.13 + 0.2 * s.z) + s.w * 6.2832) + 0.05 * sin(t * (0.41 + 0.3 * s.x) + s.y * 12.0);
  y += 0.08 * sin(t * (0.17 + 0.2 * s.w) + s.z * 6.2832) + 0.03 * sin(t * (0.53 + 0.2 * s.y) + s.x * 9.0);
  // Hidden near the wrap seam so the jump is never seen.
  float edge = 1.0 - smoothstep(wrap - 0.2, wrap, abs(x));
  vec2 p = vec2(x, y);

  // Swarm around the hand.
  float a = t * (0.4 + 0.6 * s.z) * dir + s.y * 6.2832;
  vec2 orbit = uHand + vec2(cos(a), sin(a)) * (0.06 + 0.22 * s.w);
  p = mix(p, orbit, uHandAmt * (0.35 + 0.5 * s.z));

  float blink = smoothstep(0.25, 1.0, 0.5 + 0.5 * sin(t * (0.6 + 1.2 * s.z) + s.x * 40.0));
  float spark = 0.5 + 0.5 * sin(uRealTime * (9.0 + 14.0 * s.w) + s.y * 50.0);
  float fade = clamp(uLife - position.x, 0.0, 1.0) * edge;
  vB = (blink * (0.5 + 0.8 * uTreble) + uTreble * spark * 0.9) * fade;
  gl_PointSize = (3.0 + 4.0 * s.w) * (0.7 + 0.5 * vB) * uPxScale;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.0, 1.0);
}`;

export const FLY_FRAG = `
uniform vec3 uColB;
uniform float uIntensity;
varying float vB;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(q, q);
  if (d2 > 1.0) discard;
  float a = exp(-d2 * 3.5);
  gl_FragColor = vec4(mix(uColB, vec3(1.0), 0.2) * vB * a * 2.2 * uIntensity, 1.0);
}`;
