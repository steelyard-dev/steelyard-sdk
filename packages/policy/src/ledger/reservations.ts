import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Clock {
  now(): Date;
}

export interface Reservation {
  id: string;
  rule_name: string;
  intent_id: string;
  amount_usd_minor: bigint;
  count: number;
  purchase_id: string | null;
  created_at: string;
  expires_at: string;
  status: "pending" | "committed" | "released";
  credential_id: string | null;
}

export class ReservationLedger {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    private readonly opts: { ttl_seconds: number }
  ) {}

  reserve(args: { rule_name: string; intent_id: string; amount_usd_minor: bigint; purchase_id?: string }): Reservation {
    return writeImmediate(this.db, () => {
      const id = `res_${randomUUID()}`;
      const now = this.clock.now();
      const expires = new Date(now.getTime() + this.opts.ttl_seconds * 1000);
      const row: Reservation = {
        id,
        rule_name: args.rule_name,
        intent_id: args.intent_id,
        amount_usd_minor: args.amount_usd_minor,
        count: 1,
        purchase_id: args.purchase_id ?? null,
        created_at: now.toISOString(),
        expires_at: expires.toISOString(),
        status: "pending",
        credential_id: null
      };

      this.db
        .prepare(
          `INSERT INTO reservations
            (id, rule_name, intent_id, amount_usd_minor, count, purchase_id, created_at, expires_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
        )
        .run(
          row.id,
          row.rule_name,
          row.intent_id,
          sqliteInteger(row.amount_usd_minor),
          row.count,
          row.purchase_id,
          row.created_at,
          row.expires_at
        );
      return row;
    });
  }

  commit(id: string, credential_id: string): void {
    writeImmediate(this.db, () => {
      const result = this.db
        .prepare("UPDATE reservations SET status = 'committed', credential_id = ? WHERE id = ? AND status = 'pending'")
        .run(credential_id, id);
      if (result.changes === 0) throw new Error(`reservation ${id} not pending`);
    });
  }

  release(id: string): void {
    writeImmediate(this.db, () => {
      const result = this.db.prepare("UPDATE reservations SET status = 'released' WHERE id = ? AND status = 'pending'").run(id);
      if (result.changes === 0) throw new Error(`reservation ${id} not pending`);
    });
  }

  get(id: string): Reservation | undefined {
    const row = this.db.prepare("SELECT * FROM reservations WHERE id = ?").get(id) as
      | (Omit<Reservation, "amount_usd_minor"> & { amount_usd_minor: number })
      | undefined;
    if (!row) return undefined;
    return { ...row, amount_usd_minor: BigInt(row.amount_usd_minor) };
  }

  sweepExpired(): string[] {
    const now = this.clock.now().toISOString();
    const rows = this.db.prepare("SELECT id FROM reservations WHERE status = 'pending' AND expires_at < ?").all(now) as Array<{ id: string }>;
    writeImmediate(this.db, () => {
      for (const row of rows) {
        this.db.prepare("UPDATE reservations SET status = 'released' WHERE id = ? AND status = 'pending'").run(row.id);
      }
    });
    return rows.map((row) => row.id);
  }

  recoverExpired(): string[] {
    return this.sweepExpired();
  }
}

function writeImmediate<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function sqliteInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`amount_usd_minor exceeds SQLite safe integer range: ${value}`);
  }
  return Number(value);
}
