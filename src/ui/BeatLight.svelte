<script lang="ts">
  import { engine } from '../engine/engine';

  /** Four beat lights, drawn from the clock snapshot at ~30 Hz. */
  let canvas: HTMLCanvasElement;

  $effect(() => {
    const g = canvas.getContext('2d')!;
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 33) return;
      last = t;
      const s = engine.clock.snapshot();
      g.clearRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < 4; i++) {
        const on = s.playing && s.beatInBar === i;
        g.fillStyle = on ? `rgba(${i === 0 ? '255,80,80' : '120,220,140'},${1 - s.phase * 0.7})` : '#333';
        g.beginPath();
        g.arc(7 + i * 14, 7, 5, 0, Math.PI * 2);
        g.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas bind:this={canvas} width="56" height="14"></canvas>
