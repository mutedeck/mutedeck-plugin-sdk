/** Minimal typed event emitter (no dependency on Node's `events`). */
export type Listener<A extends unknown[]> = (...args: A) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> {
  private readonly listeners = new Map<keyof Events, Set<AnyListener>>();

  /** Subscribe to an event. Returns a function that unsubscribes. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AnyListener);
    return () => this.off(event, listener);
  }

  /** Subscribe for a single emission. */
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, ((...args: Events[K]) => {
      off();
      listener(...args);
    }) as Listener<Events[K]>);
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as AnyListener);
  }

  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  /** Called when a listener throws; listeners never break the client. */
  protected onListenerError(_error: unknown): void {}
}
