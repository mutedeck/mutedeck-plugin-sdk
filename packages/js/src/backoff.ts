export interface BackoffOptions {
  /** First delay. Default 1000 ms. */
  initialDelayMs?: number;
  /** Upper bound. Default 30000 ms. */
  maxDelayMs?: number;
}

/**
 * Exponential backoff with "equal jitter": the n-th delay is between half and
 * all of `min(max, initial * 2^n)`.
 */
export class Backoff {
  private attempt = 0;
  private readonly initial: number;
  private readonly max: number;

  constructor(options: BackoffOptions = {}, private readonly random: () => number = Math.random) {
    this.initial = options.initialDelayMs ?? 1000;
    this.max = options.maxDelayMs ?? 30000;
  }

  next(): number {
    const base = Math.min(this.max, this.initial * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    return Math.round(base / 2 + (base / 2) * this.random());
  }

  reset(): void {
    this.attempt = 0;
  }
}
