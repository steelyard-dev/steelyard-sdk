import { describe, expect, it } from "vitest";
import { ApprovalBudget } from "../src/approval/budget.js";

describe("ApprovalBudget", () => {
  it("permits up to N within window", () => {
    const clock = { now: () => new Date("2026-06-28T12:00:00Z") };
    const budget = new ApprovalBudget({ max: 3, window_ms: 24 * 3600 * 1000 }, clock);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it("releases after window rolls", () => {
    let current = new Date("2026-06-28T12:00:00Z");
    const clock = { now: () => current };
    const budget = new ApprovalBudget({ max: 1, window_ms: 60_000 }, clock);
    expect(budget.tryConsume()).toBe(true);
    expect(budget.tryConsume()).toBe(false);
    current = new Date("2026-06-28T12:02:00Z");
    expect(budget.tryConsume()).toBe(true);
  });

  it("supports a zero prompt budget", () => {
    const budget = new ApprovalBudget({ max: 0, window_ms: 60_000 }, { now: () => new Date("2026-06-28T12:00:00Z") });
    expect(budget.tryConsume()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it("rejects invalid budget configuration", () => {
    expect(() => new ApprovalBudget({ max: -1, window_ms: 60_000 }, { now: () => new Date() })).toThrow(/max/);
    expect(() => new ApprovalBudget({ max: 1, window_ms: 0 }, { now: () => new Date() })).toThrow(/window_ms/);
  });
});
