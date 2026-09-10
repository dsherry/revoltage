<script lang="ts">
  import type { Zone } from '@sdk';
  import { engine } from '../engine/engine';

  /** `camera` is a device name (resolve an `input` param key before passing it). Zones are in display space. */
  let { camera, zones, onchange }: { camera: string; zones: Zone[]; onchange: (zones: Zone[]) => void } = $props();

  const vision = engine.vision;
  /** Motion fraction is scaled so the "on" threshold (0.08) sits at about a third of the bar. */
  const BAR_SCALE = 4;
  let canvas: HTMLCanvasElement;
  let selected = $state(-1);
  let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

  function pos(e: PointerEvent): [number, number] {
    const r = canvas.getBoundingClientRect();
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  }

  function inside(pts: [number, number][], x: number, y: number): boolean {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  function onDown(e: PointerEvent): void {
    const [x, y] = pos(e);
    for (let i = zones.length - 1; i >= 0; i--) {
      if (inside(zones[i].points, x, y)) { selected = i; return; }
    }
    selected = -1;
    drag = { x0: x, y0: y, x1: x, y1: y };
    canvas.setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent): void {
    if (!drag) return;
    [drag.x1, drag.y1] = pos(e);
  }

  function onUp(): void {
    const d = drag;
    drag = null;
    if (!d) return;
    const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
    const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) return;
    const taken = new Set(zones.map((z) => z.name));
    let n = 1;
    while (taken.has(`zone${n}`)) n++;
    const zone: Zone = { name: `zone${n}`, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
    selected = zones.length;
    onchange([...zones, zone]);
  }

  function rename(i: number, raw: string): void {
    const base = raw.trim() || `zone${i + 1}`;
    const taken = new Set(zones.filter((_, j) => j !== i).map((z) => z.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base}-${k}`;
    onchange(zones.map((z, j) => (j === i ? { name, points: z.points } : z)));
  }

  function remove(i: number): void {
    if (selected === i) selected = -1;
    else if (selected > i) selected--;
    onchange(zones.filter((_, j) => j !== i));
  }

  // Live frame + overlays at ~25 fps; reads props directly, never through Svelte state.
  $effect(() => {
    const g = canvas.getContext('2d');
    if (!g) return;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 40) return;
      last = t;
      const W = canvas.width, H = canvas.height;
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const v = vision.video(camera);
      if (v && v.readyState >= 2) {
        g.save();
        if (vision.isMirrored(camera)) {
          g.translate(W, 0);
          g.scale(-1, 1);
        }
        g.drawImage(v, 0, 0, W, H);
        g.restore();
      } else {
        g.fillStyle = '#777';
        g.font = '16px system-ui, sans-serif';
        g.textBaseline = 'top';
        g.fillText(`${camera || 'camera'}: offline`, 12, 12);
      }

      const states = vision.zoneStates(camera);
      g.font = '13px system-ui, sans-serif';
      g.textBaseline = 'top';
      zones.forEach((z, i) => {
        if (z.points.length < 3) return;
        const st = states[z.name];
        g.beginPath();
        z.points.forEach(([x, y], k) => (k ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
        g.closePath();
        if (st?.active) {
          g.fillStyle = 'rgba(80, 200, 120, 0.25)';
          g.fill();
        }
        g.lineWidth = i === selected ? 3 : 2;
        g.strokeStyle = st?.active ? '#4c8' : i === selected ? '#fff' : '#eb5';
        g.stroke();

        let lx = 1, ly = 1;
        for (const [x, y] of z.points) { lx = Math.min(lx, x); ly = Math.min(ly, y); }
        const px = Math.min(W - 92, lx * W + 4), py = Math.min(H - 30, ly * H + 4);
        g.fillStyle = 'rgba(0, 0, 0, 0.6)';
        g.fillRect(px - 2, py - 2, 90, st ? 28 : 19);
        g.fillStyle = '#fff';
        g.fillText(z.name, px, py, 84);
        if (st) {
          g.fillStyle = '#333';
          g.fillRect(px, py + 17, 84, 5);
          g.fillStyle = st.active ? '#4c8' : '#eb5';
          g.fillRect(px, py + 17, 84 * Math.min(1, st.motion * BAR_SCALE), 5);
          g.fillStyle = '#fff';
          g.fillRect(px + 84 * 0.08 * BAR_SCALE, py + 16, 1, 7);
        }
      });

      if (drag) {
        g.setLineDash([6, 4]);
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.strokeRect(drag.x0 * W, drag.y0 * H, (drag.x1 - drag.x0) * W, (drag.y1 - drag.y0) * H);
        g.setLineDash([]);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="editor">
  <canvas
    bind:this={canvas}
    width="640"
    height="360"
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={() => (drag = null)}
  ></canvas>
  <div class="hint">Drag on the image to add a zone; click a zone to select it.</div>
  {#each zones as z, i (i)}
    <div class="zone" class:sel={i === selected}>
      <input value={z.name} onfocus={() => (selected = i)} onchange={(e) => rename(i, e.currentTarget.value)} />
      <button onclick={() => remove(i)}>Delete</button>
    </div>
  {/each}
</div>

<style>
  .editor { display: grid; gap: 4px; max-width: 640px; }
  canvas { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 3px; cursor: crosshair; touch-action: none; display: block; }
  .hint { color: #888; font-size: 12px; }
  .zone { display: flex; gap: 6px; align-items: center; padding: 2px 4px; border-radius: 3px; }
  .zone.sel { background: #2a2a2a; }
  .zone input { flex: 1; min-width: 0; }
</style>
