import { defineApp, defineParams, type Landmark } from '@sdk';

// MediaPipe pose landmark pairs for the body (face omitted).
const BODY = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
// Hand landmark chains: palm edge and each finger from the wrist.
const HAND = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12], [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]];
const PERSON_COLORS = ['#ff3b6b', '#3bd4ff', '#ffd23b', '#7dff3b'];

export default defineApp({
  id: 'vision-check',
  name: 'Vision Check',
  description: 'Camera image with skeletons, hands and gestures, person mask and zone motion, for testing the vision setup.',
  surface: '2d',
  params: defineParams({
    camera: { type: 'input', kind: 'camera', default: 'webcam', description: 'Camera to analyse' },
    maxPeople: { type: 'slider', min: 1, max: 4, step: 1, default: 2, description: 'People to track (fewer is cheaper; applies when the app reloads)' },
    hands: { type: 'toggle', default: true, description: 'Track hands and gestures (applies when the app reloads)' },
    mask: { type: 'toggle', default: false, description: 'Person mask (costs GPU; applies when the app reloads)' },
    video: { type: 'toggle', default: true, description: 'Show the camera image' },
    zones: { type: 'zones', camera: 'camera', default: [], description: 'Motion zones: drag on the camera image below to add' },
  }),
  setup(ctx) {
    const g = ctx.surface.g2d;
    const p = ctx.params;
    const cv = ctx.vision.track({ param: 'camera' }, {
      pose: { maxPeople: p.maxPeople },
      hands: p.hands,
      mask: p.mask,
      zones: { param: 'zones' },
    });

    const line = (a: Landmark, b: Landmark, w: number, h: number) => {
      g.beginPath();
      g.moveTo(a.x * w, a.y * h);
      g.lineTo(b.x * w, b.y * h);
      g.stroke();
    };

    return {
      frame() {
        const { width: w, height: h } = ctx.surface;
        g.globalAlpha = 1;
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);

        const video = ctx.vision.video({ param: 'camera' });
        if (p.video && video && video.readyState >= 2) {
          g.save();
          if (ctx.vision.mirrored({ param: 'camera' })) { g.translate(w, 0); g.scale(-1, 1); }
          g.globalAlpha = 0.6;
          g.drawImage(video, 0, 0, w, h);
          g.restore();
        }
        if (cv.mask) {
          g.globalAlpha = 0.45;
          g.drawImage(cv.mask.bitmap, 0, 0, w, h);
          g.globalAlpha = 1;
        }

        // Zones: outline plus a fill that follows the motion amount.
        const zones = p.zones;
        for (const z of zones) {
          const st = cv.zones[z.name];
          g.beginPath();
          z.points.forEach(([x, y], i) => (i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h)));
          g.closePath();
          g.fillStyle = `rgba(255, 200, 0, ${0.5 * (st?.motion ?? 0)})`;
          g.fill();
          g.strokeStyle = st?.active ? '#ffcc00' : '#886600';
          g.lineWidth = 3;
          g.stroke();
          g.fillStyle = '#fff';
          g.font = `${Math.round(h / 30)}px system-ui`;
          g.fillText(`${z.name} ${(st?.motion ?? 0).toFixed(2)}`, z.points[0][0] * w + 6, z.points[0][1] * h + h / 25);
        }

        g.lineWidth = Math.max(3, h / 180);
        for (const person of cv.people) {
          const color = PERSON_COLORS[person.id % PERSON_COLORS.length];
          g.strokeStyle = color;
          for (const [a, b] of BODY) line(person.landmarks[a], person.landmarks[b], w, h);
          g.fillStyle = color;
          g.font = `${Math.round(h / 24)}px system-ui`;
          g.fillText(`#${person.id} speed ${person.speed.toFixed(2)}`, person.bbox.x * w, person.bbox.y * h - 8);
        }

        for (const hand of cv.hands) {
          g.strokeStyle = hand.handedness === 'Left' ? '#b58cff' : '#5cffb0';
          for (const chain of HAND) for (let i = 1; i < chain.length; i++) line(hand.landmarks[chain[i - 1]], hand.landmarks[chain[i]], w, h);
          const wrist = hand.landmarks[0];
          g.fillStyle = '#fff';
          g.font = `${Math.round(h / 28)}px system-ui`;
          g.fillText(`${hand.handedness} ${hand.gesture.name}`, wrist.x * w, wrist.y * h + h / 20);
        }

        g.fillStyle = '#9f9';
        g.font = `${Math.round(h / 36)}px ui-monospace, monospace`;
        g.fillText(
          cv.connected
            ? `cv ${cv.fps.toFixed(0)} fps · ${cv.latencyMs.toFixed(0)} ms · people ${cv.people.length} · hands ${cv.hands.length} · activity ${cv.activity.toFixed(2)}`
            : 'camera not connected',
          h / 40, h - h / 40,
        );
      },
    };
  },
});
