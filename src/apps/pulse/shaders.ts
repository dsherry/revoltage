const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
vec3 hueRotate(vec3 c, float h) {
  const vec3 k = vec3(0.57735);
  float ca = cos(h * 6.2831853), sa = sin(h * 6.2831853);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}`;

/** Pattern + feedback pass: renders into the ping-pong framebuffer. */
export const PULSE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uTime;
uniform int uMode;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform float uIntensity;
uniform float uZoom;
uniform float uWarp;
uniform float uFeedback;
uniform float uHue;
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uLevel;
uniform float uOnset;
uniform float uBeat;
${NOISE}

void main() {
  vec2 p = (vUv - uCenter) * vec2(uRes.x / uRes.y, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x);
  vec2 q = p;
  if (uMode == 1) {
    float seg = 6.2831853 / 6.0;
    float aa = abs(mod(a + uTime * 0.1, seg) - seg * 0.5);
    q = vec2(cos(aa), sin(aa)) * r;
  } else if (uMode == 2) {
    // Tunnel: sample around a circle (cos/sin of the angle) so there's no seam where atan wraps.
    float depth = 0.3 / max(r, 0.02) + uTime * 0.5;
    q = vec2(cos(a), sin(a)) * 1.2 + vec2(depth, depth * 0.6);
  }
  q *= uZoom * (1.0 + 0.12 * uBass);

  vec2 w = vec2(fbm(q * 1.5 + uTime * 0.15), fbm(q * 1.5 - uTime * 0.12 + 5.2));
  float n = fbm(q * 2.0 + uWarp * (w - 0.5) * (2.0 + 2.0 * uMid) + uTime * 0.05);
  float rings = sin(n * 12.0 + uTime * 2.0 - r * 4.0 * (1.0 + uTreble));

  vec3 col = mix(uColA, uColB, smoothstep(0.2, 0.8, n));
  col = mix(col, uColC, smoothstep(0.6, 1.0, rings * 0.5 + 0.5) * (0.3 + uTreble));
  col *= (0.25 + uLevel * 1.5) * uIntensity * (1.0 + 0.25 * uBeat);
  col += uOnset * 0.35 * uColC;
  col = hueRotate(col, uHue);

  // Feedback: last frame, pulled toward the center and slightly rotated.
  vec2 fc = vUv - uCenter;
  float ang = 0.01 + 0.03 * uMid;
  fc = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * fc * (0.985 - 0.02 * uBass);
  vec3 prev = texture(uPrev, fc + uCenter).rgb;
  outColor = vec4(mix(col, prev, uFeedback), 1.0);
}`;

/** Final pass: tone-map the feedback buffer to the canvas, plus the flash. */
export const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uFlash;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  c = 1.0 - exp(-c * 1.6);
  outColor = vec4(mix(c, vec3(1.0), uFlash), 1.0);
}`;
