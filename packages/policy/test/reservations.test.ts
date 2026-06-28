import { describe, expect, it } from "vitest";
import { openLedger } from "../src/ledger/db.js";
import { ReservationLedger, type Clock } from "../src/ledger/reservations.js";

const FIXED_NOW = new Date("2026-06-28T12:00:00Z");

function makeLedger(clock: Clock = { now: () => FIXED_NOW }) {
  const db = openLedger(":memory:");
  return { db, ledger: new ReservationLedger(db, clock, { ttl_seconds: 300 }) };
}

describe("ReservationLedger", () => {
  it("reserves and commits", () => {
    const { db, ledger } = makeLedger();
    const reservation = ledger.reserve({ rule_name: "a", intent_id: "int_1", amount_usd_minor: 1000n });
    ledger.commit(reservation.id, "ic_xyz");
    const row = ledger.get(reservation.id);
    expect(row?.status).toBe("committed");
    expect(row?.credential_id).toBe("ic_xyz");
    db.close();
  });

  it("releases instead of committing", () => {
    const { db, ledger } = makeLedger();
    const reservation = ledger.reserve({ rule_name: "a", intent_id: "int_1", amount_usd_minor: 1000n });
    ledger.release(reservation.id);
    expect(ledger.get(reservation.id)?.status).toBe("released");
    db.close();
  });

  it("stores purchase id and expiry", () => {
    const { db, ledger } = makeLedger();
    const reservation = ledger.reserve({
      rule_name: "a",
      intent_id: "int_1",
      amount_usd_minor: 1000n,
      purchase_id: "purchase_1"
    });
    expect(reservation.purchase_id).toBe("purchase_1");
    expect(reservation.expires_at).toBe("2026-06-28T12:05:00.000Z");
    db.close();
  });

  it("rejects double commit and release after commit", () => {
    const { db, ledger } = makeLedger();
    const reservation = ledger.reserve({ rule_name: "a", intent_id: "int_1", amount_usd_minor: 1000n });
    ledger.commit(reservation.id, "ic_a");
    expect(() => ledger.commit(reservation.id, "ic_b")).toThrow(/not pending/);
    expect(() => ledger.release(reservation.id)).toThrow(/not pending/);
    db.close();
  });

  it("sweepExpired releases reservations older than TTL", () => {
    let current = new Date("2026-06-28T12:00:00Z");
    const clock = { now: () => current };
    const { db, ledger } = makeLedger(clock);
    const reservation = ledger.reserve({ rule_name: "a", intent_id: "i", amount_usd_minor: 1n });
    current = new Date("2026-06-28T12:06:00Z");
    const dropped = ledger.sweepExpired();
    expect(dropped).toContain(reservation.id);
    expect(ledger.get(reservation.id)?.status).toBe("released");
    db.close();
  });

  it("keeps younger pending reservations during recovery", () => {
    let current = new Date("2026-06-28T12:00:00Z");
    const clock = { now: () => current };
    const { db, ledger } = makeLedger(clock);
    const reservation = ledger.reserve({ rule_name: "a", intent_id: "i", amount_usd_minor: 1n });
    current = new Date("2026-06-28T12:01:00Z");
    expect(ledger.recoverExpired()).toEqual([]);
    expect(ledger.get(reservation.id)?.status).toBe("pending");
    db.close();
  });

  it("rejects amounts outside SQLite safe integer range", () => {
    const { db, ledger } = makeLedger();
    expect(() =>
      ledger.reserve({ rule_name: "a", intent_id: "int_1", amount_usd_minor: BigInt(Number.MAX_SAFE_INTEGER) + 1n })
    ).toThrow(/safe integer/);
    db.close();
  });
});
