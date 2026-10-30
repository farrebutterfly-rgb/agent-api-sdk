/**
 * Fixed-window rate limit per key (the authenticated user). In memory, so it is per process:
 * correct for the single-instance server here, not shared across replicas.
 */
export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window ends. */
  resetMs: number;
}

export class FixedWindowLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(readonly limit: number, readonly windowMs: number, private readonly now: () => number = Date.now) {}

  hit(key: string): RateDecision {
    const t = this.now();
    const start = t - (t % this.windowMs);
    let w = this.windows.get(key);
    if (!w || w.start !== start) {
      w = { start, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.prune(start);
    }
    w.count++;
    const resetMs = start + this.windowMs - t;
    return { allowed: w.count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - w.count), resetMs };
  }

  private prune(current: number) {
    for (const [k, w] of this.windows) if (w.start !== current) this.windows.delete(k);
  }
}
