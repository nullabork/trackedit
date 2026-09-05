/** Minimal typed event emitter used across core, render and UI layers. */

export type Listener<T> = (event: T) => void;
export type Unsubscribe = () => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(name: K, fn: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(name, fn);
  }

  off<K extends keyof Events>(name: K, fn: Listener<Events[K]>): void {
    this.listeners.get(name)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(name: K, event: Events[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) (fn as Listener<Events[K]>)(event);
  }
}
