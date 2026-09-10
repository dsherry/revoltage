/** Max plant cells (Voronoi seeds). Must match the array sizes in the shaders below. */
export const MAX_CELLS = 24;

// Shared light model: diagonal shafts + hand pool + person mask, in scene coords (x ∈ ±aspect, y ∈ ±1).
const LIGHT = `
uniform float uTime;
uniform float uAspect;
uniform float uShaft;
uniform vec3 uHand;
uniform sampler2D uMask;
uniform float uMaskOn;
uniform float uMaskMirror;

// Sine-free hash: stays stable for the large inputs a long performance produces.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Soft god rays falling from the top left, slowly morphing and drifting sideways.
float shafts(vec2 p) {
  vec2 dir = vec2(0.48, -0.877);
  float across = dot(p, vec2(-dir.y, dir.x));
  float along = dot(p, dir);
  float n = 0.65 * noise(vec2(across * 2.1 + uTime * 0.015, uTime * 0.035))
          + 0.35 * noise(vec2(across * 5.3 + 7.0 - uTime * 0.02, uTime * 0.05 + 3.0));
  return smoothstep(0.42, 0.82, n) * (0.45 + 0.55 * smoothstep(1.6, -1.2, along));
}
float maskAt(vec2 p) {
  vec2 uv = vec2(p.x / uAspect, p.y) * 0.5 + 0.5;
  uv.x = mix(uv.x, 1.0 - uv.x, uMaskMirror);
  return texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).a * uMaskOn;
}
float handPool(vec2 p) {
  vec2 d = p - uHand.xy;
  return uHand.z * exp(-dot(d, d) * 7.0);
}
float lightAt(vec2 p) {
  return uShaft * shafts(p) + handPool(p) + 0.8 * maskAt(p);
}`;

export const BG_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const BG_FRAG = `
varying vec2 vUv;
// xy = seed, z = additive distance offset (0 = full cell, large = shrunk away), w = spark excitation.
uniform vec4 uSeeds[${MAX_CELLS}];
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform float uIntensity;
uniform float uPulse;
${LIGHT}

void main() {
  vec2 p = vec2((vUv.x * 2.0 - 1.0) * uAspect, vUv.y * 2.0 - 1.0);
  // A little wobble so walls aren't ruler-straight (particles keep a margin, so membership still agrees).
  vec2 q = p + 0.036 * (vec2(noise(p * 3.1 + uTime * 0.05), noise(p * 3.1 + 11.3 - uTime * 0.04)) - 0.5);

  float f1 = 1e3, f2 = 1e3, id = 0.0, exc1 = 0.0, exc2 = 0.0;
  vec2 seed = vec2(0.0);
  for (int i = 0; i < ${MAX_CELLS}; i++) {
    vec4 s = uSeeds[i];
    float d = length(q - s.xy) + s.z;
    if (d < f1) {
      f2 = f1; exc2 = exc1;
      f1 = d; exc1 = s.w; seed = s.xy; id = float(i);
    } else if (d < f2) {
      f2 = d; exc2 = s.w;
    }
  }
  float wall = f2 - f1;
  float rnd = hash12(vec2(id * 7.13, 3.7));

  // Light for the whole cell (so cells near the hand / inside the silhouette brighten as units) and per pixel.
  float lCell = lightAt(seed);
  float lPx = lightAt(p);

  // Dark interior tinted by colorA, a touch brighter in the cytoplasm along the walls.
  float tex = 0.75 + 0.5 * noise(p * 9.0 + rnd * 20.0 + uTime * 0.03);
  float rim = exp(-wall / 0.09);
  vec3 col = uColA * (0.018 + 0.014 * rnd + 0.03 * rim) * tex;
  col += mix(uColA, uColB, 0.45) * (0.1 * lCell + 0.03 * lPx) * (0.6 + 0.4 * tex);

  // Walls: bright middle lamella, soft halo and faint membranes on either side.
  float wc = wall / 0.009, wm = (wall - 0.034) / 0.006;
  float core = exp(-wc * wc);
  float halo = exp(-wall / 0.045);
  float memb = exp(-wm * wm);
  float wl = uPulse * (0.55 + 0.9 * lPx);
  col += uColB * (0.36 * core + 0.07 * halo) * wl;
  col += mix(uColA, uColB, 0.5) * 0.05 * memb * wl;
  col += uColC * max(exc1, exc2) * (0.9 * core + 0.18 * halo);

  // Volumetric haze of the shafts over everything.
  col += mix(uColB, vec3(1.0), 0.35) * uShaft * shafts(p) * 0.05;

  col *= 0.7 + 0.3 * smoothstep(2.2, 0.6, length(p * vec2(0.75, 1.0)));
  gl_FragColor = vec4(col * uIntensity, 1.0);
}`;

export const CHLORO_VERT = `
attribute vec4 aOrbit; // cell, radius fraction, phase, angular speed
attribute vec4 aLook;  // size (scene units), rank within its cell (0..1), random, unused
// xy = seed, z = orbit radius, w = cell visibility.
uniform vec4 uCells[${MAX_CELLS}];
uniform float uFlow;
uniform float uFill;
uniform float uPx;
uniform float uClock;
uniform float uLevel;
uniform float uTreble;
uniform float uIntensity;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec3 vCol;
varying vec2 vRot;
${LIGHT}

void main() {
  vec4 c = uCells[int(aOrbit.x + 0.5)];
  float vis = c.w * clamp((uFill - aLook.y) * 64.0, 0.0, 1.0);
  if (vis < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  // Keep in sync with orbit() in chloroplast.ts (the sparks use it).
  float a = aOrbit.z + uFlow * aOrbit.w;
  float r = aOrbit.y * c.z * (1.0 + 0.06 * sin(3.0 * a + aOrbit.z * 1.7));
  vec2 pos = c.xy + r * vec2(cos(a), sin(a));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);

  float rnd = aLook.z;
  gl_PointSize = aLook.x * uPx * (0.55 + 0.45 * vis) * (1.0 + 0.08 * uLevel);
  float ra = a + 1.5707963;
  vRot = vec2(cos(ra), sin(ra));

  float l = lightAt(pos);
  vec3 base = mix(uColA, uColB, clamp(l * 0.7, 0.0, 0.85));
  float breath = 0.3 + 0.45 * uLevel + 0.06 * sin(uClock * 0.8 + rnd * 6.2831853);
  float shimmer = 1.0 + uTreble * 0.9 * (0.5 + 0.5 * sin(uClock * (9.0 + 8.0 * rnd) + rnd * 50.0));
  vCol = base * breath * (0.7 + 1.1 * l) * shimmer * uIntensity * vis;
}`;

export const CHLORO_FRAG = `
varying vec3 vCol;
varying vec2 vRot;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  q.y = -q.y;
  q = vec2(vRot.x * q.x + vRot.y * q.y, -vRot.y * q.x + vRot.x * q.y); // x now runs along the motion
  float e = length(q / vec2(0.46, 0.25));
  if (e > 1.0) discard;
  float body = smoothstep(1.0, 0.6, e) * (0.85 + 0.15 * sin(q.x * 38.0));
  float core = exp(-e * e * 2.5);
  gl_FragColor = vec4(vCol * (0.7 * body + 0.5 * core), 1.0);
}`;

export const NODE_VERT = `
attribute vec3 aColor;
uniform float uSize;
varying vec3 vCol;
void main() {
  vCol = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = dot(aColor, vec3(1.0)) > 0.0 ? uSize : 0.0;
}`;

export const NODE_FRAG = `
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d2 = dot(q, q) * 4.0;
  if (d2 > 1.0) discard;
  gl_FragColor = vec4(vCol * (exp(-d2 * 9.0) + 0.25 * (1.0 - d2)), 1.0);
}`;
