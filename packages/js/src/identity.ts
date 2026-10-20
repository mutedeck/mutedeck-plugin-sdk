import type { ClientInfo, ClientOs, StoredCredentials, TokenStore } from "./types";

const CLIENT_ID = /^[a-z0-9-]{1,32}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const INSTANCE_ID = /^[A-Za-z0-9-]{8,64}$/;
const TOKEN = /^[0-9a-f]{64}$/;

/**
 * Returns a copy of `client` with `version` and `host_version` sanitized (see
 * {@link sanitizeVersion}; dropped when nothing usable is left). Throws a
 * `TypeError` when another field breaks the spec limits (the server would
 * answer `bad_hello`).
 */
export function validateClientInfo(input: ClientInfo): ClientInfo {
  const client: ClientInfo = { ...input };
  for (const key of ["version", "host_version"] as const) {
    if (client[key] !== undefined) {
      const sanitized = sanitizeVersion(client[key]);
      if (sanitized === undefined) {
        delete client[key];
      } else {
        client[key] = sanitized;
      }
    }
  }
  const problems: string[] = [];
  if (!CLIENT_ID.test(client.id ?? "")) {
    problems.push("client.id must match [a-z0-9-]{1,32}");
  }
  if (!client.name || client.name.length > 64) {
    problems.push("client.name must be 1-64 characters");
  }
  if (client.version !== undefined && !VERSION.test(client.version)) {
    problems.push("client.version must match [0-9A-Za-z.+-]{1,32}");
  }
  if (client.host_app !== undefined && !CLIENT_ID.test(client.host_app)) {
    problems.push("client.host_app must match [a-z0-9-]{1,32}");
  }
  if (client.host_version !== undefined && !VERSION.test(client.host_version)) {
    problems.push("client.host_version must match [0-9A-Za-z.+-]{1,32}");
  }
  if (client.os !== undefined && !["mac", "windows", "linux"].includes(client.os)) {
    problems.push("client.os must be mac, windows or linux");
  }
  if (problems.length > 0) {
    throw new TypeError(`Invalid ClientInfo: ${problems.join("; ")}`);
  }
  return client;
}

/**
 * Turns a free-form version into one the spec accepts (`[0-9A-Za-z.+-]`, at
 * most 32 characters), or `undefined` when nothing usable is left. Spaces
 * become `-` unless the rest is a parenthesised build note:
 * `"6.8.1 (21045)"` → `"6.8.1"`, `"7.0 beta 2"` → `"7.0-beta-2"`, `"7.0+abc123"` stays.
 */
export function sanitizeVersion(version: string | undefined | null): string | undefined {
  if (!version) {
    return undefined;
  }
  const cleaned = String(version)
    .trim()
    .replace(/\s*\(.*$/, "")
    .replace(/\s+/g, "-")
    .replace(/[^0-9A-Za-z.+-]/g, "")
    .slice(0, 32);
  return cleaned || undefined;
}

/** Maps `process.platform` / `navigator.platform`-style strings to `ClientInfo.os`. */
export function osFromPlatform(platform: string | undefined | null): ClientOs | undefined {
  const p = (platform ?? "").toLowerCase();
  if (p.startsWith("darwin") || p.startsWith("mac") || p === "macos") {
    return "mac";
  }
  if (p.startsWith("win")) {
    return "windows";
  }
  if (p.startsWith("linux") || p.includes("cros") || p.includes("x11")) {
    return "linux";
  }
  return undefined;
}

/**
 * Builds the `X-MuteDeck-Client` header value:
 * `<id>/<version> (<host_app> <host_version>)`.
 */
export function clientHeader(client: ClientInfo): string {
  let value = client.id;
  if (client.version) {
    value += `/${client.version}`;
  }
  if (client.host_app) {
    value += ` (${client.host_app}${client.host_version ? ` ${client.host_version}` : ""})`;
  }
  return value.slice(0, 160);
}

export function isValidToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

/** RFC 4122 v4 UUID via `crypto.randomUUID` when available. */
export function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Credentials cached in memory on top of a {@link TokenStore}. The instance id is
 * generated once and persisted; dropping the token keeps it.
 */
export class Credentials {
  private loaded?: Promise<Required<Pick<StoredCredentials, "instanceId">> & StoredCredentials>;
  private current: StoredCredentials = {};
  /** Serializes writes so a later setToken always wins over an earlier clearToken. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: TokenStore,
    private readonly generateId: () => string = randomUuid,
  ) {}

  /** Loads (once) and returns the credentials, creating the instance id if needed. */
  async get(): Promise<{ instanceId: string; token?: string }> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const data = await this.store.load().catch(() => ({}) as StoredCredentials);
        let instanceId = data.instanceId;
        const valid = instanceId !== undefined && INSTANCE_ID.test(instanceId);
        if (!valid) {
          instanceId = this.generateId();
        }
        this.current = { instanceId, token: isValidToken(data.token) ? data.token : undefined };
        if (!valid || this.current.token !== data.token) {
          await this.persist();
        }
        return this.current as { instanceId: string; token?: string };
      })();
    }
    await this.loaded;
    return { instanceId: this.current.instanceId!, token: this.current.token };
  }

  setToken(token: string): Promise<void> {
    return this.enqueue(async () => {
      await this.get();
      this.current.token = token;
      await this.persist();
    });
  }

  clearToken(): Promise<void> {
    return this.enqueue(async () => {
      await this.get();
      if (this.current.token === undefined) {
        return;
      }
      delete this.current.token;
      await this.persist();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Forget token and instance id (the next connect enrolls as a new install). */
  async reset(): Promise<void> {
    this.current = {};
    this.loaded = undefined;
    await this.store.clear();
  }

  private async persist(): Promise<void> {
    const data: StoredCredentials = { instanceId: this.current.instanceId };
    if (this.current.token) {
      data.token = this.current.token;
    }
    await this.store.save(data);
  }
}
