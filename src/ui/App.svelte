<script lang="ts">
  import TopBar from './TopBar.svelte';
  import Setlist from './Setlist.svelte';
  import Stage from './Stage.svelte';
  import Settings from './Settings.svelte';
  import LogPanel from './LogPanel.svelte';
  import Mixer from './Mixer.svelte';
  import MidiPanel from './MidiPanel.svelte';
  import { view } from './view.svelte';
  import { log } from '../engine/log';

  const tabs = ['mixer', 'midi', 'log'] as const;
  let tab = $state<(typeof tabs)[number]>('mixer');
  const errors = $derived(view.logs.filter((e) => e.level === 'error').length);
</script>

{#snippet crashed(error: unknown, reset: () => void)}
  <div class="crashed">Panel error: {String(error)} <button onclick={reset}>Retry</button></div>
{/snippet}

<!-- Each panel is an error boundary: one panel failing can't freeze the rest of the UI. -->
<div class="layout">
  <header>
    <svelte:boundary onerror={(e) => log('error', 'ui', e)} failed={crashed}><TopBar /></svelte:boundary>
  </header>
  <aside class="left">
    <svelte:boundary onerror={(e) => log('error', 'ui', e)} failed={crashed}><Setlist /></svelte:boundary>
  </aside>
  <main>
    <svelte:boundary onerror={(e) => log('error', 'ui', e)} failed={crashed}><Stage /></svelte:boundary>
    <svelte:boundary onerror={(e) => log('error', 'ui', e)} failed={crashed}><Settings /></svelte:boundary>
  </main>
  <aside class="right">
    <nav class="tabs">
      {#each tabs as t (t)}
        <button class:sel={tab === t} onclick={() => (tab = t)}>
          {t}{#if t === 'log' && errors}<span class="badge">{errors}</span>{/if}
        </button>
      {/each}
    </nav>
    <svelte:boundary onerror={(e) => log('error', 'ui', e)} failed={crashed}>
      {#if tab === 'mixer'}<Mixer />{:else if tab === 'midi'}<MidiPanel />{:else}<LogPanel />{/if}
    </svelte:boundary>
  </aside>
</div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    background: #111;
    color: #ddd;
    font: 13px/1.4 system-ui, -apple-system, sans-serif;
  }
  :global(button, select, input) {
    font: inherit;
    color: inherit;
    background: #222;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 3px 8px;
  }
  :global(button:hover:not(:disabled)) { background: #2d2d2d; }
  :global(button:disabled) { opacity: 0.4; }
  :global(kbd) {
    font: 11px ui-monospace, monospace;
    color: #999;
    border: 1px solid #444;
    border-radius: 3px;
    padding: 0 3px;
  }
  :global(h3) {
    margin: 12px 0 6px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #888;
  }
  .layout {
    display: grid;
    grid-template: 'top top top' auto 'left main right' 1fr / 230px 1fr 340px;
    height: 100vh;
  }
  header { grid-area: top; border-bottom: 1px solid #333; }
  .left { grid-area: left; border-right: 1px solid #333; overflow: auto; padding: 8px; }
  main {
    grid-area: main;
    overflow: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .right { grid-area: right; border-left: 1px solid #333; overflow: hidden; display: flex; flex-direction: column; }
  .tabs { display: flex; gap: 4px; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
  .tabs button { text-transform: capitalize; }
  .tabs .sel { background: #333; color: #fff; }
  .badge { background: #b33; color: #fff; border-radius: 8px; padding: 0 5px; margin-left: 4px; font-size: 11px; }
</style>
