import type { Timers } from "./types";

/** Timers backed by the global `setTimeout`/`clearTimeout` (looked up per call, so fake timers work). */
export const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function sleep(timers: Timers, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      timers.clearTimeout(handle);
      reject(abortError(signal!));
    };
    const handle = timers.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Aborted");
}
