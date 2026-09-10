<script lang="ts">
  /** Horizontal level meter drawn on a canvas at ~30 Hz (never through Svelte state). */
  let { read }: { read: () => number } = $props();
  let canvas: HTMLCanvasElement;

  $effect(() => {
    const g = canvas.getContext('2d')!;
    let raf = 0;
    let last = 0;
    let hold = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 33) return;
      last = t;
      const v = Math.min(1, Math.max(0, read()));
      hold = Math.max(v, hold - 0.015);
      const { width: w, height: h } = canvas;
      g.fillStyle = '#1a1a1a';
      g.fillRect(0, 0, w, h);
      g.fillStyle = v > 0.95 ? '#e44' : v > 0.8 ? '#eb5' : '#4c8';
      g.fillRect(0, 0, w * v, h);
      g.fillStyle = '#ddd';
      g.fillRect(Math.max(0, w * hold - 2), 0, 2, h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas bind:this={canvas} width="240" height="8"></canvas>

<style>
  canvas { width: 100%; height: 8px; display: block; border-radius: 2px; }
</style>
