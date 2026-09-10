const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
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
// Animated Voronoi: x = distance to the nearest seed, y = to the second nearest, z = nearest cell's random id.
vec3 voronoi(vec2 x, float t) {
  vec2 n = floor(x), f = fract(x);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = 0.5 + 0.5 * sin(t + 6.2831853 * hash2(n + g));
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; id = hash(n + g); }
      else if (d < f2) { f2 = d; }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
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
uniform float uDrift; // cumulative drift (velocityDrift); 0 leaves the pattern as-is
${NOISE}

void main() {
  vec2 p = (vUv - uCenter) * vec2(uRes.x / uRes.y, 1.0);
  // Drift rotates the pattern, moves it through the noise and shifts where A vs B falls.
  float dc = cos(uDrift * 0.5), ds = sin(uDrift * 0.5);
  p = mat2(dc, -ds, ds, dc) * p;
  vec2 travel = uDrift * vec2(0.6, 0.35);
  float shift = 0.25 * sin(uDrift * 1.1);
  float r = length(p);
  float a = atan(p.y, p.x);
  float zoom = uZoom * (1.0 + 0.12 * uBass);
  vec3 col;
  float hl; // amount of the highlight color

  if (uMode == 3) {
    // Cells: drifting Voronoi cells, each a mix of A and B; edges glow in C.
    vec2 q = p * zoom * 3.0 + travel;
    q += uWarp * 0.3 * vec2(fbm(q * 0.5 + uTime * 0.1), fbm(q * 0.5 - uTime * 0.1 + 3.1));
    vec3 v = voronoi(q, uTime * (0.6 + uMid) + uDrift);
    // Triangle wave of the cell id (equal to v.z at zero drift), so drift cycles each cell's A/B mix without jumps.
    col = mix(uColA, uColB, abs(fract(v.z * 0.5 + 0.5 + uDrift * 0.1) * 2.0 - 1.0)) * (1.1 - v.x);
    hl = (1.0 - smoothstep(0.0, 0.06 + 0.12 * uTreble, v.y - v.x)) * (0.5 + uTreble);
  } else if (uMode == 4) {
    // Ripple: interference of three wandering wave sources.
    vec2 q = p * zoom;
    float s = 0.0;
    for (int k = 0; k < 3; k++) {
      float fk = float(k);
      vec2 src = 0.45 * vec2(cos(uTime * 0.23 + fk * 2.1 + uDrift * 0.7), sin(uTime * 0.31 + fk * 1.7 + uDrift * 0.7));
      s += sin(length(q - src) * (14.0 + 10.0 * uMid) * (1.0 + uWarp * 0.3) - uTime * 3.0);
    }
    s /= 3.0;
    col = mix(uColA, uColB, smoothstep(-0.6, 0.6, s + 1.6 * shift));
    hl = smoothstep(0.7, 1.0, abs(s)) * (0.4 + uTreble);
  } else {
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
    q = q * zoom + travel;
    vec2 w = vec2(fbm(q * 1.5 + uTime * 0.15), fbm(q * 1.5 - uTime * 0.12 + 5.2));
    float n = fbm(q * 2.0 + uWarp * (w - 0.5) * (2.0 + 2.0 * uMid) + uTime * 0.05);
    float rings = sin(n * 12.0 + uTime * 2.0 - r * 4.0 * (1.0 + uTreble));
    col = mix(uColA, uColB, smoothstep(0.2, 0.8, n + shift));
    hl = smoothstep(0.6, 1.0, rings * 0.5 + 0.5) * (0.3 + uTreble);
  }

  col = mix(col, uColC, clamp(hl, 0.0, 1.0));
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
