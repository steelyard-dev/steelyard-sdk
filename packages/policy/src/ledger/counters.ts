import type Database from "better-sqlite3";
import type { Clock } from "./reservations.js";

export class Counters {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock
  ) {}

  perDayUsdMinor(rule_name: string): bigint {
    const row = this.db.prepare(`${sumSql()} AND rule_name = ? AND created_at >= ?`).get(this.now(), rule_name, this.windowStart()) as {
      amount: number;
    };
    return BigInt(row.amount);
  }

  perDayCount(rule_name: string): number {
    const row = this.db.prepare(`${countSql()} AND rule_name = ? AND created_at >= ?`).get(this.now(), rule_name, this.windowStart()) as {
      count: number;
    };
    return row.count;
  }

  perPurchaseUsdMinor(purchase_id: string): bigint {
    const row = this.db.prepare(`${sumSql()} AND purchase_id = ?`).get(this.now(), purchase_id) as { amount: number };
    return BigInt(row.amount);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private windowStart(): string {
    return new Date(this.clock.now().getTime() - 24 * 3600 * 1000).toISOString();
  }
}

function activeReservationPredicate(): string {
  return "(status = 'committed' OR (status = 'pending' AND expires_at >= ?))";
}

function sumSql(): string {
  return `SELECT COALESCE(SUM(amount_usd_minor), 0) AS amount FROM reservations WHERE ${activeReservationPredicate()}`;
}

function countSql(): string {
  return `SELECT COALESCE(SUM(count), 0) AS count FROM reservations WHERE ${activeReservationPredicate()}`;
}
