import { describe, expect, it } from "vitest";
import {
  SESSION_GROUP_STAGES,
  SUGGESTED_SESSION_GROUPS,
  validateSessionGroups,
} from "./types";

describe("validateSessionGroups", () => {
  it("accepts a valid grouping", () => {
    expect(validateSessionGroups(SUGGESTED_SESSION_GROUPS)).toEqual([]);
  });

  it("rejects an empty group (schema requires >=1 member)", () => {
    const errors = validateSessionGroups({ planning: [] });
    expect(errors.some((e) => e.includes("at least one stage"))).toBe(true);
  });

  it("rejects an empty group name", () => {
    const errors = validateSessionGroups({ "": ["open"] });
    expect(errors.some((e) => e.includes("cannot be empty"))).toBe(true);
  });

  it("rejects a name longer than 64 chars", () => {
    const errors = validateSessionGroups({ ["x".repeat(65)]: ["open"] });
    expect(errors.some((e) => e.includes("exceeds 64"))).toBe(true);
  });

  it("rejects a status assigned to two groups", () => {
    const errors = validateSessionGroups({ a: ["open"], b: ["open"] });
    expect(errors.some((e) => e.includes("more than one group"))).toBe(true);
  });
});

describe("session group constants", () => {
  it("exposes the 8 dispatchable statuses", () => {
    expect(SESSION_GROUP_STAGES.map((s) => s.status)).toEqual([
      "open",
      "confirmed",
      "clarified",
      "approved",
      "developed",
      "testing",
      "reopen",
      "released",
    ]);
  });

  it("suggested default keeps code (approved) and fix (reopen) apart", () => {
    const all = Object.values(SUGGESTED_SESSION_GROUPS);
    const withApproved = all.find((m) => m.includes("approved"));
    expect(withApproved).toBeDefined();
    expect(withApproved).not.toContain("reopen");
  });
});
