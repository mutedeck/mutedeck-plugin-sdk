import { WebSocket } from "ws";
import { MockMuteDeck, type MockServerOptions } from "@mutedeck/mock-server";
import { MuteDeckClient, type MuteDeckClientOptions, type WebSocketLike } from "../src/index";
import type { Logger, Timers } from "../src/types";

/** Deterministic timers for the client; real I/O keeps running on the real event loop. */
export class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  /** Pending timer delays relative to now. */
  get pending(): number[] {
    return [...this.tasks.values()].map((t) => t.at - this.now).sort((a, b) => a - b);
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.tasks) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) {
          next = entry;
        }
      }
      if (!next) {
        break;
      }
      this.tasks.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
      await tick();
    }
    this.now = target;
    await tick();
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Poll `predicate` on real time until it holds. */
export async function until(predicate: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const nodeWebSocket = (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike;

export async function startMock(options: MockServerOptions = {}): Promise<MockMuteDeck> {
  return MockMuteDeck.start({ decisionDelayMs: 5, ...options });
}

export function makeClient(mock: MockMuteDeck, options: Partial<MuteDeckClientOptions> = {}): MuteDeckClient {
  return new MuteDeckClient({
    client: { id: "streamdeck", name: "Stream Deck", version: "13.1.0", host_app: "stream-deck", host_version: "6.8.1", os: "mac" },
    host: mock.host,
    port: mock.wsPort,
    webSocketFactory: nodeWebSocket,
    random: () => 1,
    ...options,
  });
}

/** Logger that records every call so tests can assert on it. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const record = (level: string) => (message: string, ...args: unknown[]) => {
    lines.push(`${level} ${message} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
  };
  return { lines, debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
}

/** A scriptable WebSocketLike for tests that don't need a server. */
export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.({});
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  fail(): void {
    this.onerror?.({});
    this.close();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
