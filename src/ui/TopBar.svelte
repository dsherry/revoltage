<script lang="ts">
  import { engine } from '../engine/engine';
  import { view } from './view.svelte';
  import BeatLight from './BeatLight.svelte';

  const scales = [1, 0.75, 0.5];
</script>

<div class="bar">
  <strong class="logo">REVOLTAGE</strong>
  {#if !view.started}
    <button class="start" disabled={view.starting} onclick={() => engine.start()}>
      {view.starting ? 'Starting…' : 'Start'}
    </button>
  {/if}
  <span class="clock">
    <BeatLight />
    <input type="number" min="30" max="300" step="0.1" value={view.clock.bpm.toFixed(1)} disabled={view.clock.source === 'midi'}
      onchange={(e) => engine.clock.setBpm(Number(e.currentTarget.value))} title="BPM" />
    <button disabled={view.clock.source === 'midi'} onclick={() => engine.clock.tap()}>Tap <kbd>T</kbd></button>
    <button disabled={view.clock.source === 'midi'} onclick={() => engine.clock.togglePlay()}>
      {view.clock.playing ? 'Stop' : 'Play'} <kbd>Space</kbd>
    </button>
    <select value={view.clock.source} onchange={(e) => engine.clock.setSource(e.currentTarget.value as 'internal' | 'midi')}>
      <option value="internal">Internal clock</option>
      <option value="midi">Follow MIDI clock</option>
    </select>
  </span>
  <button onclick={() => engine.output.open()}>{view.outputOpen ? 'Focus output' : 'Open output'} <kbd>O</kbd></button>
  <button disabled={!view.outputOpen} onclick={() => engine.output.requestFullscreen()}>Fullscreen</button>
  <button class:on={view.blackout} onclick={() => engine.toggleBlackout()}>Blackout <kbd>B</kbd></button>
  <button class:danger={view.panicked} onclick={() => engine.togglePanic()}>
    {view.panicked ? 'Release panic' : 'Panic'} <kbd>⇧P</kbd>
  </button>
  <span class="vol" class:low={view.started && view.master < 0.05} title="Master volume (APC master fader or Mixer)">
    Vol {Math.round(view.master * 100)}%
  </span>
  <label>
    Render
    <select value={view.renderScale} onchange={(e) => engine.setRenderScale(Number(e.currentTarget.value))}>
      {#each scales as s (s)}<option value={s}>{s * 100}%</option>{/each}
    </select>
  </label>
  <span class="stats">
    {view.size.w}×{view.size.h} · {view.stats.fps.toFixed(0)} fps · frame p95 {view.stats.frameP95.toFixed(1)} ms ·
    app {view.stats.appP95.toFixed(1)} · mirror {view.stats.mirrorP95.toFixed(2)}
  </span>
</div>

<style>
  .bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap; }
  .logo { letter-spacing: 0.2em; margin-right: 8px; color: #fff; }
  .start { background: #1f6f3f; border-color: #2e9a5a; color: #fff; font-weight: 600; }
  .on { background: #555; color: #fff; }
  .danger { background: #8b1d1d; border-color: #c33; color: #fff; }
  .clock { display: flex; align-items: center; gap: 4px; padding: 0 8px; border-left: 1px solid #333; border-right: 1px solid #333; }
  .clock input { width: 64px; }
  .vol { font: 12px ui-monospace, monospace; padding: 2px 6px; border-radius: 3px; }
  .vol.low { background: #b00; color: #fff; font-weight: 700; }
  .stats { margin-left: auto; color: #8a8; font: 12px ui-monospace, monospace; }
</style>
