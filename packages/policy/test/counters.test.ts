import { describe, expect, it } from "vitest";
import { openLedger } from "../src/ledger/db.js";
import { Counters } from "../src/ledger/counters.js";
import { ReservationLedger } from "../src/ledger/reservations.js";

function setup() {
  let current = new Date("2026-06-28T12:00:00Z");
  const clock = { now: () => current };
  const db = openLedger(":memory:");
  const ledger = new ReservationLedger(db, clock, { ttl_seconds: 600 });
  const counters = new Counters(db, clock);
  return {
    db,
    ledger,
    counters,
    setNow(value: string) {
      current = new Date(value);
    }
  };
}

describe("Counters", () => {
  it("sums per-day USD across committed and pending reservations within 24h", () => {
    const { db, ledger, counters } = setup();
    ledger.commit(ledger.reserve({ rule_name: "r", intent_id: "i1", amount_usd_minor: 1000n }).id, "c1");
    ledger.reserve({ rule_name: "r", intent_id: "i2", amount_usd_minor: 500n });
    expect(counters.perDayUsdMinor("r")).toBe(1500n);
    expect(counters.perDayCount("r")).toBe(2);
    db.close();
  });

  it("excludes reservations older than 24h", () => {
    const { db, ledger, counters, setNow } = setup();
    ledger.commit(ledger.reserve({ rule_name: "r", intent_id: "i1", amount_usd_minor: 1000n }).id, "c1");
    setNow("2026-06-29T13:00:00Z");
    expect(counters.perDayUsdMinor("r")).toBe(0n);
    expect(counters.perDayCount("r")).toBe(0);
    db.close();
  });

  it("excludes released and expired pending reservations", () => {
    const { db, ledger, counters, setNow } = setup();
    ledger.release(ledger.reserve({ rule_name: "r", intent_id: "released", amount_usd_minor: 1000n }).id);
    ledger.reserve({ rule_name: "r", intent_id: "expired", amount_usd_minor: 500n });
    setNow("2026-06-28T12:11:00Z");
    expect(counters.perDayUsdMinor("r")).toBe(0n);
    expect(counters.perDayCount("r")).toBe(0);
    db.close();
  });

  it("keeps committed reservations after their original expiry time", () => {
    const { db, ledger, counters, setNow } = setup();
    ledger.commit(ledger.reserve({ rule_name: "r", intent_id: "i1", amount_usd_minor: 1000n }).id, "c1");
    setNow("2026-06-28T12:11:00Z");
    expect(counters.perDayUsdMinor("r")).toBe(1000n);
    db.close();
  });

  it("perPurchaseUsdMinor sums across rules for a purchase_id", () => {
    const { db, ledger, counters } = setup();
    ledger.commit(ledger.reserve({ rule_name: "r1", intent_id: "i1", amount_usd_minor: 1000n, purchase_id: "p1" }).id, "c1");
    ledger.reserve({ rule_name: "r2", intent_id: "i2", amount_usd_minor: 500n, purchase_id: "p1" });
    ledger.reserve({ rule_name: "r2", intent_id: "i3", amount_usd_minor: 200n, purchase_id: "p2" });
    expect(counters.perPurchaseUsdMinor("p1")).toBe(1500n);
    db.close();
  });
});
