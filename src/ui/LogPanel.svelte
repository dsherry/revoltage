<script lang="ts">
  import { view } from './view.svelte';

  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
</script>

<div class="head">
  <h3>Log</h3>
  <button onclick={() => view.logs.splice(0)}>Clear</button>
</div>
<div class="list">
  {#each view.logs.toReversed() as e (e.id)}
    <div class="row {e.level}">
      <span class="meta">{time(e.time)} {e.source}</span>
      <span class="msg">{e.msg}</span>
    </div>
  {/each}
</div>

<style>
  .head { display: flex; justify-content: space-between; align-items: center; padding: 0 8px; }
  .list { overflow: auto; flex: 1; font: 12px ui-monospace, monospace; padding: 0 8px 8px; }
  .row { border-bottom: 1px solid #222; padding: 3px 0; white-space: pre-wrap; word-break: break-word; }
  .meta { color: #777; margin-right: 6px; }
  .warn .msg { color: #eb5; }
  .error .msg { color: #f77; }
</style>
