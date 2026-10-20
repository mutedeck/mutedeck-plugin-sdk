import type { StoredCredentials, StoredCredentialsJson, TokenStore } from "./types";

/** Keeps credentials in memory only (lost on restart). Useful for tests and scripts. */
export function memoryTokenStore(initial: StoredCredentials = {}): TokenStore {
  let data: StoredCredentials = { ...initial };
  return {
    load: async () => ({ ...data }),
    save: async (next) => {
      data = { ...next };
    },
    clear: async () => {
      data = {};
    },
  };
}

/**
 * Adapts any async key-value storage. The credentials are stored as one object
 * under `key`.
 *
 * ```ts
 * // chrome.storage.local (MV3)
 * const store = fromAsyncKeyValue(
 *   async (k) => (await chrome.storage.local.get(k))[k],
 *   (k, v) => chrome.storage.local.set({ [k]: v }),
 *   (k) => chrome.storage.local.remove(k),
 * );
 * ```
 */
export function fromAsyncKeyValue(
  get: (key: string) => Promise<unknown> | unknown,
  set: (key: string, value: StoredCredentialsJson) => Promise<unknown> | unknown,
  remove: (key: string) => Promise<unknown> | unknown,
  key = "mutedeck.credentials",
): TokenStore {
  return {
    load: async () => sanitize(await get(key)),
    save: async (data) => {
      await set(key, sanitize(data));
    },
    clear: async () => {
      await remove(key);
    },
  };
}

/**
 * Same as {@link fromAsyncKeyValue} for stores that only hold strings (Raycast
 * `LocalStorage`, `localStorage`, ...). The value is JSON-encoded.
 */
export function fromAsyncStringStorage(
  get: (key: string) => Promise<string | undefined | null> | string | undefined | null,
  set: (key: string, value: string) => Promise<unknown> | unknown,
  remove: (key: string) => Promise<unknown> | unknown,
  key = "mutedeck.credentials",
): TokenStore {
  return fromAsyncKeyValue(
    async (k) => {
      const raw = await get(k);
      if (!raw) {
        return undefined;
      }
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    (k, v) => set(k, JSON.stringify(v)),
    remove,
    key,
  );
}

function sanitize(value: unknown): StoredCredentialsJson {
  if (!value || typeof value !== "object") {
    return {};
  }
  const source = value as Record<string, unknown>;
  const result: StoredCredentialsJson = {};
  if (typeof source.token === "string" && source.token) {
    result.token = source.token;
  }
  if (typeof source.instanceId === "string" && source.instanceId) {
    result.instanceId = source.instanceId;
  }
  return result;
}
