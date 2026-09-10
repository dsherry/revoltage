import { untrack } from 'svelte';
import { engine } from '../engine/engine';
import { onLog, recentLogs, type LogEntry } from '../engine/log';
import { registry } from '../engine/registry';

/** UI-facing snapshot of engine state. Synced on engine events, stats at 4 Hz. */
export const view = $state({
  started: false,
  starting: false,
  blackout: false,
  panicked: false,
  outputOpen: false,
  activeSlot: -1,
  setlist: [] as (string | null)[],
  apps: [] as { id: string; name: string; description: string }[],
  currentId: null as string | null,
  currentName: '',
  currentDescription: '',
  status: 'idle' as string,
  mountCount: 0,
  renderScale: 1,
  size: { w: 0, h: 0 },
  stats: { fps: 0, frameP95: 0, appP95: 0, mirrorP95: 0 },
  clock: { bpm: 120, playing: false, source: 'internal' as 'internal' | 'midi' },
  logs: [...recentLogs()] as LogEntry[],
});

function sync(): void {
  view.started = engine.started;
  view.starting = engine.starting;
  view.blackout = engine.blackout;
  view.panicked = engine.panicked;
  view.outputOpen = engine.output.isOpen;
  view.activeSlot = engine.activeSlot;
  view.setlist = [...engine.setlist];
  view.apps = registry.list().map(({ id, name, description }) => ({ id, name, description }));
  const def = engine.host.current?.def;
  view.currentId = def?.id ?? null;
  view.currentName = def?.name ?? '';
  view.currentDescription = def?.description ?? '';
  view.status = engine.host.status;
  view.mountCount = engine.host.mountCount;
  view.renderScale = engine.renderScale;
  const s = engine.surfaceSize();
  view.size = { w: s.w, h: s.h };
  syncClock();
}

function syncClock(): void {
  const c = engine.clock.snapshot();
  view.clock = { bpm: c.bpm, playing: c.playing, source: engine.clock.source };
}

// Engine events and logs can fire while a component effect is running; never let them become dependencies.
engine.events.on(() => untrack(sync));
setInterval(() => {
  view.stats = engine.stats.summary();
  view.outputOpen = engine.output.isOpen;
  syncClock();
}, 250);
onLog((e) => untrack(() => {
  view.logs.push(e);
  if (view.logs.length > 200) view.logs.splice(0, view.logs.length - 200);
}));
sync();
