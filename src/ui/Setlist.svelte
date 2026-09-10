<script lang="ts">
  import { engine } from '../engine/engine';
  import { view } from './view.svelte';
</script>

<h3>Setlist</h3>
{#each view.setlist as id, i (i)}
  <div class="slot" class:active={i === view.activeSlot && view.currentId === id}>
    <span class="num">{i + 1}</span>
    <select value={id ?? ''} onchange={(e) => engine.setSlot(i, e.currentTarget.value || null)}>
      <option value="">—</option>
      {#each view.apps as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
    </select>
    <button disabled={!id || !view.started} onclick={() => engine.loadSlot(i)} title="Load (key {i + 1})">▶</button>
  </div>
{/each}

<h3>Library</h3>
{#each view.apps as a (a.id)}
  <button class="app" disabled={!view.started} onclick={() => engine.loadApp(a.id)}>
    <b>{a.name}</b>
    <span>{a.description}</span>
  </button>
{/each}

<style>
  .slot { display: flex; gap: 4px; align-items: center; margin-bottom: 4px; padding: 2px; border-radius: 4px; }
  .slot.active { background: #1f3f5f; }
  .num { width: 14px; color: #888; text-align: right; }
  .slot select { flex: 1; min-width: 0; }
  .app { display: block; width: 100%; text-align: left; margin-bottom: 4px; }
  .app span { display: block; color: #999; font-size: 12px; }
</style>
