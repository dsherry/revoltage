import { defineApp, defineParams } from '@sdk';

export default defineApp({
  id: 'test-pattern',
  name: 'Test Pattern',
  description: 'Moving bars or rings with a frame counter, for checking the output window, fps and settings.',
  surface: '2d',
  params: defineParams({
    speed: { type: 'slider', min: 0, max: 4, default: 1, description: 'Animation speed' },
    count: { type: 'slider', min: 1, max: 64, step: 1, default: 16, description: 'Number of bars or rings' },
    shape: { type: 'select', options: ['bars', 'rings'], default: 'bars', description: 'What to draw' },
    color: { type: 'color', default: '#33ccff', description: 'Main color' },
    info: { type: 'toggle', default: true, description: 'Show the grid and frame info' },
    center: { type: 'xy', default: { x: 0.5, y: 0.5 }, min: 0, max: 1, description: 'Center of the rings' },
    flash: { type: 'trigger', description: 'White flash' },
  }),
  setup(ctx) {
    const g = ctx.surface.g2d;
    let phase = 0;
    let flash = 0;

    return {
      frame(f) {
        const { width: w, height: h } = ctx.surface;
        const p = ctx.params;
        phase += f.dt * p.speed;
        if (f.fired('flash')) flash = 1;
        flash = Math.max(0, flash - f.dt * 3);

        g.globalAlpha = 1;
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        g.fillStyle = g.strokeStyle = p.color;

        if (p.shape === 'bars') {
          const bw = w / p.count;
          for (let i = 0; i < p.count; i++) {
            g.globalAlpha = 0.5 + 0.5 * Math.sin(phase * 2 + i * 0.4);
            g.fillRect(i * bw, 0, bw * 0.8, h);
          }
        } else {
          const cx = p.center.x * w, cy = p.center.y * h, maxR = Math.hypot(w, h) * 0.6;
          g.lineWidth = Math.max(2, h / 200);
          for (let i = 0; i < p.count; i++) {
            const r = (((i + phase) % p.count) / p.count) * maxR;
            g.globalAlpha = 1 - r / maxR;
            g.beginPath();
            g.arc(cx, cy, r, 0, Math.PI * 2);
            g.stroke();
          }
        }
        g.globalAlpha = 1;

        if (p.info) {
          g.strokeStyle = '#444';
          g.lineWidth = 1;
          for (let x = 0; x <= 8; x++) { g.beginPath(); g.moveTo((x * w) / 8, 0); g.lineTo((x * w) / 8, h); g.stroke(); }
          for (let y = 0; y <= 8; y++) { g.beginPath(); g.moveTo(0, (y * h) / 8); g.lineTo(w, (y * h) / 8); g.stroke(); }
          g.fillStyle = '#fff';
          g.font = `${Math.round(h / 24)}px ui-monospace, monospace`;
          g.fillText(`${w}×${h}  frame ${f.frame}  t ${f.t.toFixed(1)}s  dt ${(f.dt * 1000).toFixed(1)}ms`, h / 30, h / 12);
        }
        if (flash > 0) {
          g.fillStyle = `rgba(255,255,255,${flash})`;
          g.fillRect(0, 0, w, h);
        }
      },
    };
  },
});
