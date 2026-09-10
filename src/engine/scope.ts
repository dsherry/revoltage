import { log } from './log';

/** Collects disposers for everything an app acquires; run in reverse on unmount. */
export class Scope {
  private fns: (() => void)[] = [];

  add(fn: () => void): () => void {
    this.fns.push(fn);
    return fn;
  }

  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) {
      try { fn(); } catch (e) { log('warn', 'scope', 'disposer failed', e); }
    }
  }
}

export class Emitter {
  private fns = new Set<() => void>();

  on(fn: () => void): () => void {
    this.fns.add(fn);
    return () => { this.fns.delete(fn); };
  }

  emit(): void {
    for (const fn of this.fns) fn();
  }
}
