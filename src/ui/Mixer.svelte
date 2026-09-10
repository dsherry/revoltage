<script lang="ts">
  import { engine } from '../engine/engine';
  import { shortNameFor } from '../engine/devices';
  import Meter from './Meter.svelte';

  const audio = engine.audio;

  // Strips and devices are plain engine objects; re-snapshot them on engine events and twice a second.
  let tick = $state(0);
  $effect(() => {
    const off = engine.events.on(() => tick++);
    const iv = setInterval(() => tick++, 500);
    return () => { off(); clearInterval(iv); };
  });

  const snap = $derived.by(() => {
    void tick;
    const ctx = audio.ctx;
    const strips = [...audio.strips.values()].map((s) => ({
      name: s.name, label: s.label, connected: s.connected, gain: s.state.gain, muted: s.state.muted, warning: s.warning,
    }));
    const used = new Set([...audio.strips.values()].map((s) => s.deviceId));
    return {
      started: !!ctx,
      state: ctx?.state ?? 'not started',
      rate: ctx?.sampleRate ?? 0,
      latency: ctx ? (ctx.baseLatency + ctx.outputLatency) * 1000 : 0,
      reduction: audio.limiter?.reduction ?? 0,
      master: audio.masterVolume,
      strips,
      addable: audio.inputs.filter((d) => !used.has(d.deviceId)),
      outputs: audio.outputs,
      sink: audio.outputs.find((o) => o.label === audio.sinkLabel)?.deviceId ?? '',
    };
  });

  function addInput(e: Event & { currentTarget: HTMLSelectElement }): void {
    const label = e.currentTarget.value;
    e.currentTarget.value = '';
    if (label) audio.strip(shortNameFor(label) ?? label);
  }
</script>

<div class="mixer">
  {#if !snap.started}
    <p class="muted">Audio starts with the Start button.</p>
  {:else}
    {#if snap.state !== 'running'}
      <button class="warn" onclick={() => audio.ctx?.resume()}>Audio {snap.state}: click to resume</button>
    {/if}
    <div class="info">{snap.rate} Hz · latency {snap.latency.toFixed(1)} ms · limiter {snap.reduction.toFixed(1)} dB</div>

    <h3>Inputs</h3>
    {#each snap.strips as s (s.name)}
      <div class="strip" class:off={!s.connected}>
        <div class="row">
          <b>{s.name}</b>
          <span class="label">{s.connected ? s.label : 'not connected'}</span>
        </div>
        <Meter read={() => audio.strips.get(s.name)?.features.level ?? 0} />
        <div class="row">
          <button class:muted-btn={s.muted} onclick={() => audio.setMonitor(s.name, { muted: !s.muted })}>
            {s.muted ? 'Muted' : 'Live'}
          </button>
          <input type="range" min="0" max="1.5" step="0.01" value={s.gain}
            oninput={(e) => audio.setMonitor(s.name, { gain: Number(e.currentTarget.value) })} />
          <span class="num">{s.gain.toFixed(2)}</span>
        </div>
        {#if s.warning}<div class="warning">⚠ {s.warning}</div>{/if}
      </div>
    {/each}
    {#if snap.addable.length}
      <select onchange={addInput}>
        <option value="">+ add input…</option>
        {#each snap.addable as d (d.deviceId)}<option value={d.label}>{d.label}</option>{/each}
      </select>
    {/if}

    <h3>Master</h3>
    <Meter read={() => audio.masterFeatures?.level ?? 0} />
    <div class="row">
      <input type="range" min="0" max="1" step="0.01" value={snap.master}
        oninput={(e) => audio.setMasterVolume(Number(e.currentTarget.value))} />
      <span class="num">{snap.master.toFixed(2)}</span>
    </div>
    <label class="row">
      Output
      <select value={snap.sink} onchange={(e) => audio.setOutput(e.currentTarget.value)}>
        <option value="">System default</option>
        {#each snap.outputs as o (o.deviceId)}<option value={o.deviceId}>{o.label}</option>{/each}
      </select>
    </label>
  {/if}
</div>

<style>
  .mixer { padding: 0 8px 8px; overflow: auto; }
  .muted { color: #777; }
  .info { color: #8a8; font: 12px ui-monospace, monospace; margin: 4px 0; }
  .strip { border: 1px solid #2a2a2a; border-radius: 4px; padding: 6px; margin-bottom: 6px; display: grid; gap: 4px; }
  .strip.off { opacity: 0.5; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row input[type='range'] { flex: 1; }
  .label { color: #999; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { font: 12px ui-monospace, monospace; color: #aaa; width: 34px; text-align: right; }
  .muted-btn { background: #5a1f1f; border-color: #933; }
  .warn { background: #6a4a10; border-color: #a82; width: 100%; margin: 4px 0; }
  .warning { color: #eb5; font-size: 12px; }
  label.row select { flex: 1; min-width: 0; }
</style>
