import type { Engine } from './engine';

/** Global shortcuts (§9 of the spec). Also receives keys forwarded from the output window. */
export function handleKey(e: KeyboardEvent, engine: Engine): void {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const k = e.key;
  if (k.length === 1 && k >= '1' && k <= '8') void engine.loadSlot(Number(k) - 1);
  else if (k === 'b' || k === 'B') engine.toggleBlackout();
  else if (k === 'P' && e.shiftKey) engine.togglePanic();
  else if (k === 'o' || k === 'O') void engine.output.open();
  else return;
  e.preventDefault();
}
