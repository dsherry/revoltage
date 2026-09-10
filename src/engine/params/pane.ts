import { Pane, type FolderApi } from 'tweakpane';
import type { InputKind, ParamSchema } from '@sdk';
import type { ParamStore } from './store';

/** Builds the settings page for one app from its param schema. */
export function buildPane(
  container: HTMLElement,
  schema: ParamSchema,
  store: ParamStore,
  deviceNames: (kind: InputKind) => string[],
): { dispose(): void } {
  const pane = new Pane({ container });
  const folders = new Map<string, FolderApi>();
  const parentFor = (group?: string): Pane | FolderApi => {
    if (!group) return pane;
    let f = folders.get(group);
    if (!f) folders.set(group, (f = pane.addFolder({ title: group })));
    return f;
  };
  const v = store.values as Record<string, unknown>;
  let refreshing = false;

  for (const [key, def] of Object.entries(schema)) {
    const parent = parentFor(def.group);
    const label = def.label ?? key;
    let element: HTMLElement;

    if (def.type === 'trigger') {
      const b = parent.addButton({ title: label });
      b.on('click', () => store.fire(key));
      element = b.element;
    } else if (def.type === 'zones') {
      // The zone editor (drawn on a camera preview) arrives with vision (M8).
      const b = parent.addButton({ title: `${label}: edit on camera (coming with vision)`, disabled: true });
      element = b.element;
    } else {
      let opts: Record<string, unknown> = { label };
      switch (def.type) {
        case 'slider':
        case 'number':
          opts = { label, min: def.min, max: def.max, step: def.step };
          break;
        case 'select':
          opts = { label, options: Object.fromEntries(def.options.map((o) => [o, o])) };
          break;
        case 'color':
          opts = { label, view: 'color' };
          break;
        case 'xy':
          opts = { label, x: { min: def.min ?? 0, max: def.max ?? 1 }, y: { min: def.min ?? 0, max: def.max ?? 1 } };
          break;
        case 'vec3': {
          const r = { min: def.min, max: def.max };
          opts = { label, x: r, y: r, z: r };
          break;
        }
        case 'input': {
          const names = new Set([...deviceNames(def.kind), def.default ?? '', String(v[key] ?? '')]);
          names.delete('');
          opts = { label, options: Object.fromEntries([...names].map((n) => [n, n])) };
          break;
        }
      }
      const binding = parent.addBinding(v, key, opts);
      binding.on('change', () => { if (!refreshing) store.changed(key); });
      element = binding.element;
    }
    element.title = def.description;
  }

  // Values changed from code (ctx.params.set, presets, MIDI) → refresh the widgets, at most once per frame.
  let raf = 0;
  const off = store.onAny(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refreshing = true;
      pane.refresh();
      refreshing = false;
    });
  });

  return {
    dispose() {
      off();
      cancelAnimationFrame(raf);
      pane.dispose();
    },
  };
}
