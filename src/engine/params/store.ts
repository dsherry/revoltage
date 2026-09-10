import type { ParamSchema, Params, PresetsAPI } from '@sdk';
import { load, save } from '../persist';
import { log } from '../log';
import { coerce, defaultOf } from './coerce';

type Values = Record<string, unknown>;

/**
 * Live param values for one mounted app. `values` is the object Tweakpane binds
 * to and apps read from; writes go through set()/changed() so listeners,
 * autosave and the settings page stay in sync.
 */
export class ParamStore {
  readonly values: Values = {};
  readonly api: Params<ParamSchema>;
  readonly presets: PresetsAPI;
  private listeners = new Map<string, Set<(v: unknown) => void>>();
  private anyListeners = new Set<(key: string) => void>();
  private saveTimer = 0;
  private seen: Record<string, number> = {};
  private firedNow = new Set<string>();

  constructor(readonly appId: string, readonly schema: ParamSchema) {
    const saved = load<Values>(this.key('params'), {});
    for (const [k, def] of Object.entries(schema)) {
      this.values[k] = def.type === 'trigger' ? 0 : coerce(def, saved[k] ?? defaultOf(def));
      if (def.type === 'trigger') this.seen[k] = 0;
    }
    Object.defineProperties(this.values, {
      set: { value: (k: string, v: unknown) => this.set(k, v) },
      on: { value: (k: string, cb: (v: unknown) => void) => this.on(k, cb) },
      fire: { value: (k: string) => this.fire(k) },
    });
    this.api = this.values as unknown as Params<ParamSchema>;
    this.presets = {
      list: () => Object.keys(this.loadPresets()).sort(),
      save: (name) => {
        const all = this.loadPresets();
        all[name] = this.snapshot();
        save(this.key('presets'), all);
      },
      recall: (name) => {
        const p = this.loadPresets()[name];
        if (!p) { log('warn', this.appId, `no preset "${name}"`); return; }
        for (const [k, def] of Object.entries(this.schema)) if (def.type !== 'trigger' && k in p) this.set(k, p[k]);
      },
      remove: (name) => {
        const all = this.loadPresets();
        delete all[name];
        save(this.key('presets'), all);
      },
    };
  }

  get(key: string): unknown {
    return this.values[key];
  }

  set(key: string, value: unknown): void {
    const def = this.schema[key];
    if (!def) { log('warn', this.appId, `unknown param "${key}"`); return; }
    this.values[key] = coerce(def, value);
    this.changed(key);
  }

  /** Call after a value was mutated in place (e.g. by Tweakpane). */
  changed(key: string): void {
    const v = this.values[key];
    this.listeners.get(key)?.forEach((cb) => {
      try { cb(v); } catch (e) { log('error', this.appId, `param listener for "${key}" threw`, e); }
    });
    for (const cb of this.anyListeners) cb(key);
    if (this.schema[key]?.type !== 'trigger') this.scheduleSave();
  }

  on(key: string, cb: (v: unknown) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(cb);
    return () => { set.delete(cb); };
  }

  onAny(cb: (key: string) => void): () => void {
    this.anyListeners.add(cb);
    return () => { this.anyListeners.delete(cb); };
  }

  fire(key: string): void {
    if (this.schema[key]?.type !== 'trigger') return;
    this.values[key] = (this.values[key] as number) + 1;
    this.changed(key);
  }

  /** Snapshot which triggers fired since the previous frame. */
  beginFrame(): void {
    this.firedNow.clear();
    for (const k in this.seen) {
      const count = this.values[k] as number;
      if (count !== this.seen[k]) {
        this.firedNow.add(k);
        this.seen[k] = count;
      }
    }
  }

  readonly fired = (key: string): boolean => this.firedNow.has(key);

  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    save(this.key('params'), this.snapshot());
  }

  snapshot(): Values {
    const out: Values = {};
    for (const [k, def] of Object.entries(this.schema)) if (def.type !== 'trigger') out[k] = structuredClone(this.values[k]);
    return out;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      save(this.key('params'), this.snapshot());
    }, 300);
  }

  private loadPresets(): Record<string, Values> {
    return load<Record<string, Values>>(this.key('presets'), {});
  }

  private key(kind: 'params' | 'presets'): string {
    return `app:${this.appId}:${kind}`;
  }
}
