<script lang="ts">
  import { engine } from '../engine/engine';
  import { view } from './view.svelte';

  let host: HTMLDivElement;
  $effect(() => {
    host.appendChild(engine.stageEl);
    return () => engine.stageEl.remove();
  });
</script>

<div class="wrap">
  <div bind:this={host}></div>
  {#if !view.started}
    <div class="overlay">Click <b>&nbsp;Start&nbsp;</b> to begin</div>
  {:else if view.status === 'loading'}
    <div class="overlay">Loading…</div>
  {:else if view.status === 'suspended' || view.status === 'error'}
    <div class="overlay err">
      App {view.status} (see log) &nbsp;<button onclick={() => engine.host.restart()}>Restart app</button>
    </div>
  {/if}
  {#if view.blackout}<div class="badge">BLACKOUT</div>{/if}
</div>

<style>
  .wrap { position: relative; }
  .overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #aaa; background: rgba(0, 0, 0, 0.6); font-size: 15px;
  }
  .err { color: #f88; }
  .badge {
    position: absolute; top: 8px; left: 8px; background: #b00; color: #fff;
    font-weight: 700; padding: 2px 8px; border-radius: 3px; letter-spacing: 0.1em;
  }
</style>
