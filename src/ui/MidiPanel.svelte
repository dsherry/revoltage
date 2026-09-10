<script lang="ts">
  import { untrack } from 'svelte';
  import type { MidiEvent } from '@sdk';
  import { engine } from '../engine/engine';

  const midi = engine.midi;
  const clock = engine.clock;

  const fmt = (e: MidiEvent): string => {
    const time = new Date(performance.timeOrigin + e.t).toLocaleTimeString([], { hour12: false });
    const what = e.note !== undefined ? `note ${e.note} vel ${Math.round((e.velocity ?? 0) * 127)}`
      : e.cc !== undefined ? `cc ${e.cc} = ${Math.round((e.value ?? 0) * 127)}`
      : [...e.raw].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return `${time}  ${e.device}  ${e.type} ch${e.ch}  ${what}`;
  };

  let tick = $state(0);
  let events = $state<string[]>(midi.recent().map(fmt).reverse().slice(0, 100));

  $effect(() => {
    const off = engine.events.on(() => untrack(() => tick++));
    const iv = setInterval(() => untrack(() => tick++), 500);
    // Batch monitor updates to one per animation frame.
    let pending: string[] = [];
    let raf = 0;
    const offEv = midi.onEvent((e) => {
      pending.push(fmt(e));
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const batch = pending.reverse();
        pending = [];
        untrack(() => { events = [...batch, ...events].slice(0, 100); });
      });
    });
    return () => { off(); clearInterval(iv); offEv(); cancelAnimationFrame(raf); };
  });

  const snap = $derived.by(() => {
    void tick;
    return {
      enabled: midi.enabled,
      error: midi.error,
      ports: midi.ports(),
      apc: { connected: midi.apc.connected, shift: midi.apc.shift, pickedUp: midi.apc.pickedUp, faders: Array.from(midi.apc.faders) },
      ins: midi.names('midiIn'),
      outs: midi.names('midiOut'),
      source: clock.source,
      follow: clock.follow,
      sendTo: [...clock.sendTo],
    };
  });

  function toggleSend(name: string, on: boolean): void {
    clock.setSendTo(on ? [...snap.sendTo, name] : snap.sendTo.filter((n) => n !== name));
  }
</script>

<div class="midi">
  {#if snap.error}<div class="warning">⚠ {snap.error}</div>{/if}
  {#if !snap.enabled && !snap.error}<p class="muted">MIDI starts with the Start button.</p>{/if}

  <h3>Devices</h3>
  {#each snap.ports as p (p.label)}
    <div class="port" class:off={!p.connected}>
      <b>{p.name}</b> <span class="label">{p.label}</span>
      <span class="io">{p.input ? 'in' : ''}{p.input && p.output ? ' / ' : ''}{p.output ? 'out' : ''}</span>
    </div>
  {:else}
    <p class="muted">No MIDI devices.</p>
  {/each}

  {#if snap.apc.connected}
    <h3>APC mini</h3>
    <div class="faders">
      {#each snap.apc.faders as v, i (i)}
        <div class="fader" title="Fader {i + 1}"><div style="height: {v * 100}%"></div></div>
      {/each}
    </div>
    <div class="muted small">
      Shift {snap.apc.shift ? 'held' : 'up'} · master fader {snap.apc.pickedUp ? 'controls volume' : 'move it to pick up the volume'}
    </div>
  {/if}

  <h3>Clock</h3>
  <label class="row">
    Follow
    <select value={snap.follow} onchange={(e) => clock.setFollow(e.currentTarget.value)}>
      {#each [...new Set([snap.follow, ...snap.ins])] as n (n)}<option value={n}>{n}</option>{/each}
    </select>
    <span class="muted small">(when “Follow MIDI clock” is selected)</span>
  </label>
  <div class="row wrap">
    Send clock to
    {#each snap.outs as n (n)}
      <label><input type="checkbox" checked={snap.sendTo.includes(n)} onchange={(e) => toggleSend(n, e.currentTarget.checked)} /> {n}</label>
    {/each}
  </div>

  <h3>Monitor</h3>
  <div class="monitor">
    {#each events as line, i (i)}<div>{line}</div>{/each}
  </div>
</div>

<style>
  .midi { padding: 0 8px 8px; overflow: auto; display: flex; flex-direction: column; min-height: 0; flex: 1; }
  .muted { color: #777; }
  .small { font-size: 12px; }
  .warning { color: #eb5; margin: 6px 0; }
  .port { display: flex; gap: 6px; align-items: baseline; padding: 2px 0; }
  .port.off { opacity: 0.45; }
  .label { color: #999; font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .io { color: #8a8; font-size: 11px; }
  .faders { display: flex; gap: 6px; height: 48px; margin-bottom: 4px; }
  .fader { flex: 1; background: #1a1a1a; border-radius: 2px; display: flex; align-items: flex-end; }
  .fader div { width: 100%; background: #4c8; border-radius: 2px; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .wrap { flex-wrap: wrap; }
  .monitor { font: 11px ui-monospace, monospace; color: #bbb; overflow: auto; flex: 1; min-height: 120px; }
</style>
