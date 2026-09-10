export type LogLevel = 'info' | 'warn' | 'error';
export interface LogEntry { id: number; time: number; level: LogLevel; source: string; msg: string }

const entries: LogEntry[] = [];
const listeners = new Set<(e: LogEntry) => void>();
let nextId = 1;
let outbox: string[] = [];

function fmt(a: unknown): string {
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function log(level: LogLevel, source: string, ...args: unknown[]): void {
  const e: LogEntry = { id: nextId++, time: Date.now(), level, source, msg: args.map(fmt).join(' ') };
  entries.push(e);
  if (entries.length > 500) entries.shift();
  for (const l of listeners) l(e);
  const out = level === 'info' ? console.log : (consoleOut ?? console)[level];
  out(`[${source}]`, ...args);
  outbox.push(JSON.stringify({ t: new Date(e.time).toISOString(), level, source, msg: e.msg }));
}

export const recentLogs = (): readonly LogEntry[] => entries;

export function onLog(fn: (e: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Mirror logs to the dev server (.devlog/browser.log), batched.
setInterval(() => {
  if (!outbox.length) return;
  const body = outbox.join('\n');
  outbox = [];
  fetch('/__devlog', { method: 'POST', body, keepalive: true }).catch(() => {});
}, 500);

/**
 * Also capture console.error / console.warn from libraries (three.js reports shader compile
 * errors this way), so they reach the log panel and .devlog. Our own log() writes to the console
 * through the saved originals, so nothing loops.
 */
function captureConsole(): void {
  const orig = { error: console.error.bind(console), warn: console.warn.bind(console) };
  const forward = (level: 'error' | 'warn') => (...args: unknown[]) => {
    orig[level](...args);
    const e: LogEntry = { id: nextId++, time: Date.now(), level, source: 'console', msg: args.map(fmt).join(' ') };
    entries.push(e);
    if (entries.length > 500) entries.shift();
    for (const l of listeners) l(e);
    outbox.push(JSON.stringify({ t: new Date(e.time).toISOString(), level, source: 'console', msg: e.msg }));
  };
  console.error = forward('error');
  console.warn = forward('warn');
  consoleOut = orig;
}

let consoleOut: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } | null = null;

export function installErrorHandlers(win: Window, source: string): void {
  if (!consoleOut) captureConsole();
  win.addEventListener('error', (ev) => {
    if (ev.error instanceof Error) { log('error', source, ev.error); return; }
    // Non-Error throws and browser-dispatched errors: keep whatever detail there is.
    const where = ev.filename ? ` at ${ev.filename}:${ev.lineno}:${ev.colno}` : '';
    log('error', source, `${ev.message || '(no message)'}${where} [${typeof ev.error}: ${String(ev.error)}]`);
  });
  win.addEventListener('unhandledrejection', (ev) => log('error', source, 'unhandled rejection:', ev.reason));
}
