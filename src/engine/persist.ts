import { log } from './log';

const NS = 'rv1:';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch (e) {
    log('warn', 'persist', `could not save ${key}`, e);
  }
}

/** Everything Revoltage has stored, for export to a JSON file. */
export function exportAll(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(NS)) continue;
    try { out[k] = JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { /* skip corrupt entries */ }
  }
  return out;
}

export function importAll(data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) if (k.startsWith(NS)) localStorage.setItem(k, JSON.stringify(v));
}
