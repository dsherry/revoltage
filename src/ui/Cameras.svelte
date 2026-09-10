<script lang="ts">
  import { engine } from '../engine/engine';

  const vision = engine.vision;

  // Camera state is plain engine objects; re-snapshot on engine events and twice a second.
  let tick = $state(0);
  $effect(() => {
    const off = engine.events.on(() => tick++);
    const iv = setInterval(() => tick++, 500);
    return () => { off(); clearInterval(iv); };
  });

  const snap = $derived.by(() => {
    void tick;
    return { status: vision.status, permission: vision.registry.permission, cameras: vision.cameras() };
  });

  /** Live thumbnail at ~10 fps, drawn from the camera's video element (never through Svelte state). */
  function preview(canvas: HTMLCanvasElement, name: string) {
    let current = name;
    const g = canvas.getContext('2d');
    const iv = setInterval(() => {
      if (!g) return;
      const { width: w, height: h } = canvas;
      const v = vision.video(current);
      if (!v || v.readyState < 2) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, w, h);
        return;
      }
      g.save();
      if (vision.isMirrored(current)) {
        g.translate(w, 0);
        g.scale(-1, 1);
      }
      g.drawImage(v, 0, 0, w, h);
      g.restore();
    }, 100);
    return {
      update(n: string) { current = n; },
      destroy() { clearInterval(iv); },
    };
  }

  const f0 = (n: number) => n.toFixed(0);
</script>

<div class="cams">
  {#if snap.status === 'idle'}
    <p class="muted">Cameras start with the Start button.</p>
  {:else if snap.permission === 'denied'}
    <p class="warning">⚠ Camera permission denied. Allow cameras in Chrome's site settings, then reload.</p>
  {:else if snap.permission === 'unsupported'}
    <p class="warning">⚠ Camera API unavailable (needs localhost or https).</p>
  {:else if !snap.cameras.length}
    <p class="muted">{snap.status === 'starting' ? 'Opening cameras…' : 'No cameras found.'}</p>
  {/if}

  {#each snap.cameras as c (c.label)}
    <div class="cam" class:off={!c.connected}>
      <canvas use:preview={c.name} width="160" height="90"></canvas>
      <div class="info">
        <div class="row">
          <b>{c.name}</b>
          {#if c.name !== c.label}<span class="label" title={c.label}>{c.label}</span>{/if}
        </div>
        {#if c.connected}
          <div class="num">{c.width}×{c.height} · {f0(c.fps)} fps</div>
          <label class="row">
            <input type="checkbox" checked={c.mirrored} onchange={(e) => vision.setMirrored(c.name, e.currentTarget.checked)} />
            Mirror
          </label>
        {:else}
          <div class="label">not connected</div>
        {/if}
      </div>
      <div class="cv">
        {#if c.subscribers}
          <div class="num">
            CV {f0(c.cvFps)} fps · {f0(c.cvLatencyMs)} ms latency · {f0(c.cvWorkerMs)} ms/frame
            {#if c.degrade}<span class="warn-text">· degraded {c.degrade}</span>{/if}
          </div>
          <div class="num">running: {c.activeTasks.join(', ') || 'zones only'}</div>
        {:else}
          <div class="num muted">CV idle (no subscribers)</div>
        {/if}
        <div class="num" title={c.tasks.join('\n')}>
          models: {c.tasks.length ? c.tasks.join(' · ') : 'not loaded'}
          {#if c.delegate === 'CPU' || c.delegate === 'GPU+CPU'}<span class="warn-text">(CPU fallback)</span>{/if}
        </div>
        {#if c.error}<div class="warning" title={c.error}>⚠ {c.error}</div>{/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .cams { padding: 0 8px 8px; overflow: auto; }
  .muted { color: #777; }
  .cam {
    border: 1px solid #2a2a2a; border-radius: 4px; padding: 6px; margin-bottom: 6px;
    display: grid; grid-template-columns: 160px 1fr; gap: 4px 8px;
  }
  .cam.off { opacity: 0.5; }
  canvas { width: 160px; height: 90px; background: #000; border-radius: 2px; display: block; }
  .info { display: grid; gap: 2px; align-content: start; min-width: 0; }
  .cv { grid-column: 1 / -1; display: grid; gap: 2px; }
  .row { display: flex; gap: 6px; align-items: center; min-width: 0; }
  .label { color: #999; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { font: 12px ui-monospace, monospace; color: #aaa; overflow: hidden; text-overflow: ellipsis; }
  .warning { color: #eb5; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .warn-text { color: #eb5; }
</style>
