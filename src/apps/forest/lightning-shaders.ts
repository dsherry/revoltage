// GLSL for the Lightning Forest scene (three's default GLSL1-style ShaderMaterial dialect).

const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}`;

/** Full-screen quad in clip space (ignores the camera). */
export const SCREEN_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Night sky: gradient, stars, moon, drifting fog bands, lightning flash. */
export const SKY_FRAG = `
varying vec2 vUv;
uniform float uAspect;
uniform float uTime;
uniform float uSky;
uniform float uMoonLight;
uniform float uFlash;
uniform float uFlashX;
uniform float uBass;
uniform float uTreble;
uniform float uIntensity;
uniform vec2 uMoon;
uniform vec3 uFog;
uniform vec3 uFlashCol;
uniform vec3 uColB;
${NOISE}

void main() {
  vec2 p = vec2((vUv.x * 2.0 - 1.0) * uAspect, vUv.y * 2.0 - 1.0);
  vec3 col = mix(vec3(0.018, 0.024, 0.045), vec3(0.003, 0.004, 0.010), smoothstep(-0.35, 1.0, p.y)) * uSky;

  // Fog bands: a thick one along the tree line and a thin high one, slowly rolling (faster with bass).
  float roll = uTime * (0.018 + 0.03 * uBass);
  vec2 q = vec2(p.x * 0.55 + roll, p.y * 2.6);
  float w = noise(q * 0.8 + vec2(-uTime * 0.013, uTime * 0.007));
  float f = fbm(q + vec2(w * 1.6 - uTime * 0.01, w * 0.4));
  float b1 = (p.y + 0.05) / 0.5, b2 = (p.y - 0.58) / 0.16;
  float bands = exp(-b1 * b1) + 0.55 * exp(-b2 * b2);
  float fog = smoothstep(0.35, 0.85, f) * bands * (0.85 + 0.35 * uBass);
  fog = clamp(fog, 0.0, 1.0);

  // Stars, hidden by fog and near the horizon.
  vec2 sg = p * 55.0;
  vec2 cell = floor(sg);
  float sh = hash(cell);
  vec2 so = vec2(hash(cell + 7.3), hash(cell + 1.9)) * 0.6 + 0.2;
  float star = step(0.972, sh) * (1.0 - smoothstep(0.0, 0.14, length(fract(sg) - so)));
  float tw = 0.55 + 0.45 * sin(uTime * (1.5 + 3.0 * uTreble) + sh * 80.0);
  col += vec3(0.75, 0.82, 1.0) * star * tw * (0.12 + 0.35 * fract(sh * 91.0)) * smoothstep(-0.05, 0.5, p.y) * (1.0 - fog);

  // Moon: bright disc (bloom makes it glow) plus a soft halo that also lights nearby fog.
  vec2 dm = p - uMoon;
  float d = length(dm);
  float disc = 1.0 - smoothstep(0.058, 0.064, d);
  float mottled = 0.82 + 0.18 * noise(dm * 38.0 + 3.0);
  vec3 moonCol = mix(vec3(1.0, 0.96, 0.88), uColB, 0.12);
  float halo = exp(-d * 7.0) * 0.07 + exp(-d * 2.2) * 0.02;
  col += moonCol * halo * uMoonLight;
  col = mix(col, uFog * (1.6 + 2.5 * exp(-d * 2.5) * uMoonLight), fog * 0.85);
  col += moonCol * disc * mottled * (0.5 + 1.2 * uMoonLight) * (1.0 - 0.6 * fog);

  // Lightning flash: the whole sky lifts, clouds near the bolt light up the most.
  float near = exp(-abs(p.x - uFlashX) * 1.1);
  col += uFlashCol * uFlash * (0.04 + near * (0.1 + 0.45 * fog)) * smoothstep(-0.7, 0.6, p.y);

  gl_FragColor = vec4(col * uIntensity, 1.0);
}`;

/** Pine layer: trees wrap around a fixed span one tree at a time, so there are no seams. */
export const PINE_VERT = `
attribute vec3 aInfo; // x: tree center, y: edge (0 inside .. 1 on the outline), z: sway weight
uniform float uScroll;
uniform float uSpan;
uniform float uTime;
uniform float uSway;
varying float vEdge;
varying vec2 vWorld;
void main() {
  float cx = mod(aInfo.x - uScroll + uSpan * 0.5, uSpan) - uSpan * 0.5;
  float seed = fract(aInfo.x * 13.37);
  float sway = sin(uTime * (0.5 + 0.3 * seed) + seed * 6.2831) * uSway * aInfo.z * aInfo.z;
  vec2 p = vec2(cx + position.x + sway, position.y);
  vEdge = aInfo.y;
  vWorld = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

export const PINE_FRAG = `
varying float vEdge;
varying vec2 vWorld;
uniform vec3 uFog;
uniform vec3 uDark;
uniform vec3 uColC;
uniform vec3 uFlashCol;
uniform float uFogMix;
uniform float uGround;
uniform float uRim;
uniform float uFlash;
uniform float uTime;
uniform float uIntensity;
${NOISE}

void main() {
  // Ground mist along this layer's base, drifting.
  float mist = 1.0 - smoothstep(uGround - 0.12, uGround + 0.3, vWorld.y);
  mist *= 0.5 + 0.9 * noise(vec2(vWorld.x * 1.3 + uTime * 0.05, vWorld.y * 3.0));
  float fogAmt = clamp(uFogMix + (1.0 - uFogMix) * 0.4 * mist, 0.0, 1.0);
  vec3 col = mix(uDark, uFog, fogAmt);
  col += uFlashCol * uFlash * fogAmt * 0.12;
  col += uColC * smoothstep(0.8, 1.0, vEdge) * uRim * 1.6;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}`;

/** Fireflies: every particle's path is a function of time and its random attributes. */
export const FIREFLY_VERT = `
attribute vec4 aRand;  // x: base x, y: base y, z: phase, w: speed
attribute vec4 aRand2; // x: hand attraction, y: blink rate, z: size, w: sparkle rate
uniform float uTime;
uniform float uAspect;
uniform float uPx;
uniform float uScale;
uniform float uMid;
uniform float uTreble;
uniform float uBeat;
uniform vec2 uYRange;
uniform vec3 uHand; // xy: scene position, z: amount
varying float vBright;
void main() {
  float ph = aRand.z * 6.2831;
  float t = uTime * (0.5 + aRand.w);
  float wrap = uAspect + 0.2;
  float x = (aRand.x * 2.0 - 1.0) * wrap + t * 0.025 * (aRand.w - 0.55)
    + 0.24 * sin(t * 0.31 + ph) + 0.1 * sin(t * 0.83 + ph * 2.3);
  x = mod(x + wrap, 2.0 * wrap) - wrap;
  float y = mix(uYRange.x, uYRange.y, aRand.y)
    + 0.1 * sin(t * 0.37 + ph * 1.7) + 0.045 * sin(t * 1.1 + ph * 3.1);
  vec2 pos = vec2(x, y);

  vec2 toHand = uHand.xy - pos;
  float pull = uHand.z * aRand2.x * exp(-dot(toHand, toHand) * 1.6);
  pos += toHand * pull * 0.8 + vec2(cos(t * 1.7 + ph), sin(t * 1.3 + ph)) * 0.09 * pull;

  float blink = pow(max(0.0, sin(uTime * aRand2.y * (1.0 + 0.6 * uTreble) + ph)), 3.0);
  float sparkle = uTreble * pow(max(0.0, sin(uTime * aRand2.w + ph * 5.0)), 12.0);
  vBright = (0.18 + 0.82 * blink + sparkle) * (0.65 + 0.7 * uMid) * (1.0 + 0.6 * uBeat);

  gl_PointSize = uPx * uScale * aRand2.z * (0.7 + 0.35 * blink) * (1.0 + 0.25 * uBeat);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 0.0, 1.0);
}`;

export const FIREFLY_FRAG = `
varying float vBright;
uniform vec3 uColB;
uniform float uGain;
uniform float uIntensity;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 22.0);
  float halo = exp(-r2 * 4.5) * (1.0 - r2);
  vec3 col = mix(uColB, vec3(1.0, 1.0, 0.9), core * 0.5) * (core * 2.4 + halo * 0.35);
  gl_FragColor = vec4(col * vBright * uGain * uIntensity, 1.0);
}`;

/** Lightning bolt: a quad strip whose cross-section fades from a white-hot core to a colorC glow. */
export const BOLT_VERT = `
attribute vec2 aNrm;
attribute vec3 aData; // x: width scale, y: distance along the bolt (0 top .. 1 end), z: brightness
uniform float uWidth;
varying float vSide;
varying float vAlong;
varying float vBright;
void main() {
  vec2 p = position.xy + aNrm * position.z * uWidth * aData.x;
  vSide = position.z;
  vAlong = aData.y;
  vBright = aData.z;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

export const BOLT_FRAG = `
varying float vSide;
varying float vAlong;
varying float vBright;
uniform vec3 uColC;
uniform float uFade;
uniform float uReveal;
uniform float uIntensity;
void main() {
  float s = abs(vSide);
  float core = exp(-s * s * 30.0);
  float glow = pow(max(0.0, 1.0 - s), 2.5);
  float reveal = 1.0 - smoothstep(uReveal - 0.04, uReveal, vAlong);
  vec3 col = uColC * glow * 0.7 + mix(uColC, vec3(1.0), 0.75) * core * 3.2;
  gl_FragColor = vec4(col * vBright * uFade * reveal * uIntensity, 1.0);
}`;

/** Performer silhouette: dark body with bioluminescent spots, a bright inner rim and a soft outer halo. */
export const MASK_FRAG = `
varying vec2 vUv;
uniform sampler2D uMask;
uniform float uMirrored;
uniform float uAspect;
uniform float uAmount;
uniform float uTime;
uniform float uFlash;
uniform float uIntensity;
uniform vec3 uColB;
uniform vec3 uColC;
${NOISE}

float m(vec2 uv) {
  return texture2D(uMask, vec2(uMirrored > 0.5 ? 1.0 - uv.x : uv.x, 1.0 - uv.y)).a;
}

void main() {
  float c = smoothstep(0.35, 0.65, m(vUv));
  vec2 r1 = vec2(0.006 / uAspect, 0.006);
  vec2 r2 = vec2(0.03 / uAspect, 0.03);
  float near = 0.0, far = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982 + 0.39;
    vec2 d = vec2(cos(a), sin(a));
    near += m(vUv + d * r1);
    far += m(vUv + d * r2);
  }
  near *= 0.125;
  far *= 0.125;
  float rim = c * clamp((1.0 - near) * 2.5, 0.0, 1.0);
  float halo = far * (1.0 - c);
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float spots = smoothstep(0.62, 0.9, noise(p * 14.0 + vec2(uTime * 0.15, -uTime * 0.2)));
  float shimmer = noise(p * 3.0 - uTime * 0.1);
  vec3 emit = uColC * rim * (1.3 + 1.5 * uFlash)
    + uColB * halo * 0.3
    + c * (uColB * spots * 0.7 + uColC * shimmer * 0.03);
  vec3 body = vec3(0.002, 0.003, 0.006);
  gl_FragColor = vec4((emit + body * c) * uAmount * uIntensity, c * 0.92 * uAmount);
}`;
