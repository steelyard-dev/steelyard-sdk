import type { Clock } from "../ledger/reservations.js";

export interface ApprovalBudgetOptions {
  max: number;
  window_ms: number;
}

export class ApprovalBudget {
  private timestamps: number[] = [];

  constructor(
    private readonly opts: ApprovalBudgetOptions,
    private readonly clock: Clock
  ) {
    if (!Number.isSafeInteger(opts.max) || opts.max < 0) throw new Error("approval budget max must be a non-negative integer");
    if (!Number.isSafeInteger(opts.window_ms) || opts.window_ms <= 0) throw new Error("approval budget window_ms must be positive");
  }

  tryConsume(): boolean {
    this.prune();
    if (this.timestamps.length >= this.opts.max) return false;
    this.timestamps.push(this.clock.now().getTime());
    return true;
  }

  remaining(): number {
    this.prune();
    return Math.max(0, this.opts.max - this.timestamps.length);
  }

  private prune(): void {
    const cutoff = this.clock.now().getTime() - this.opts.window_ms;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}
