<script lang="ts">
  import TopBar from './TopBar.svelte';
  import Setlist from './Setlist.svelte';
  import Stage from './Stage.svelte';
  import Settings from './Settings.svelte';
  import LogPanel from './LogPanel.svelte';
</script>

<div class="layout">
  <header><TopBar /></header>
  <aside class="left"><Setlist /></aside>
  <main>
    <Stage />
    <Settings />
  </main>
  <aside class="right"><LogPanel /></aside>
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
</style>
