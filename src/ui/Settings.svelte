<script lang="ts">
  import { untrack } from 'svelte';
  import { engine } from '../engine/engine';
  import { view } from './view.svelte';
  import { buildPane } from '../engine/params/pane';
  import { exportAll, importAll } from '../engine/persist';
  import ZoneEditor from './ZoneEditor.svelte';
  import type { Zone } from '@sdk';

  let paneEl: HTMLDivElement | undefined = $state();
  let presets = $state<string[]>([]);
  let chosen = $state('');
  let newName = $state('');
  let zoneParams = $state<{ key: string; label: string; camera: string; zones: Zone[] }[]>([]);

  // Rebuild the settings page on every mount (including hot reloads of the same app).
  // Only mountCount and the container are dependencies; the rest is untracked so
  // writing `presets` here can't re-trigger this effect.
  $effect(() => {
    void view.mountCount;
    const el = paneEl;
    return untrack(() => {
      zoneParams = [];
      const m = engine.host.current;
      if (!m || !el) return;
      const pane = buildPane(el, m.def.params, m.store, (k) => engine.deviceNames(k));
      const list = m.store.presets.list();
      presets = list;
      chosen = list[0] ?? '';
      // Zones params get a camera zone editor; its camera may come from an `input` param.
      const params = m.def.params;
      const refreshZones = () => untrack(() => {
        zoneParams = Object.entries(params).flatMap(([key, d]) => {
          if (d.type !== 'zones') return [];
          const camera = params[d.camera]?.type === 'input' ? String(m.store.get(d.camera) ?? '') : d.camera;
          return [{ key, label: d.label ?? key, camera, zones: m.store.get(key) as Zone[] }];
        });
      });
      refreshZones();
      const off = m.store.onAny((k) => {
        const t = params[k]?.type;
        if (t === 'zones' || t === 'input') refreshZones();
      });
      return () => { off(); pane.dispose(); };
    });
  });

  const store = () => engine.host.current?.store;

  function savePreset(): void {
    const name = newName.trim();
    if (!name) return;
    store()?.presets.save(name);
    presets = store()?.presets.list() ?? [];
    chosen = name;
    newName = '';
  }

  function removePreset(): void {
    if (!chosen || !confirm(`Delete preset "${chosen}"?`)) return;
    store()?.presets.remove(chosen);
    presets = store()?.presets.list() ?? [];
    chosen = presets[0] ?? '';
  }

  function doExport(): void {
    store()?.flush();
    const blob = new Blob([JSON.stringify(exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `revoltage-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function doImport(e: Event): Promise<void> {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !confirm('Replace saved settings with this file and reload?')) return;
    importAll(JSON.parse(await file.text()));
    location.reload();
  }
</script>

<section>
  {#if view.currentId}
    <div class="title"><b>{view.currentName}</b> <span>{view.currentDescription}</span></div>
    <div class="presets">
      <select bind:value={chosen} disabled={!presets.length}>
        {#each presets as p (p)}<option value={p}>{p}</option>{/each}
      </select>
      <button disabled={!chosen} onclick={() => store()?.presets.recall(chosen)}>Recall</button>
      <button disabled={!chosen} onclick={removePreset}>Delete</button>
      <input placeholder="new preset name" bind:value={newName} onkeydown={(e) => e.key === 'Enter' && savePreset()} />
      <button disabled={!newName.trim()} onclick={savePreset}>Save</button>
      <button onclick={() => confirm('Reset all settings of this app to their defaults?') && store()?.reset()}>Reset</button>
    </div>
  {:else}
    <div class="title muted">No app loaded</div>
  {/if}
  <div class="pane" bind:this={paneEl}></div>
  {#each zoneParams as z (z.key)}
    <div class="zones">
      <h3>{z.label} · camera {z.camera || 'default'}</h3>
      <ZoneEditor camera={z.camera} zones={z.zones} onchange={(zs) => store()?.set(z.key, zs)} />
    </div>
  {/each}
  <div class="io">
    <button onclick={doExport}>Export all settings</button>
    <label class="import">Import… <input type="file" accept="application/json" onchange={doImport} /></label>
  </div>
</section>

<style>
  .title span { color: #999; margin-left: 6px; }
  .muted { color: #777; }
  .presets { display: flex; gap: 4px; margin: 6px 0; flex-wrap: wrap; }
  .presets input { width: 140px; }
  .pane { max-width: 420px; }
  .zones { max-width: 640px; margin-top: 8px; }
  .io { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
  .import { border: 1px solid #444; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
  .import input { display: none; }
</style>
