import { describe, expect, it } from "vitest";
import {
  applyCheckpointMode,
  deriveCheckpointMode,
  isCheckpointGated,
  type PipelineConfig,
  SESSION_GROUP_STAGES,
  SUGGESTED_SESSION_GROUPS,
  validateSessionGroups,
} from "./types";

describe("checkpoint mode — Manual ⇄ Skip", () => {
  // Regression: Manual→Skip merges {enabled:false} onto the existing
  // {mode:"manual",enabled:true} entry, leaving `mode:"manual"`. deriveCheckpointMode
  // MUST treat enabled:false as Skip (not read the stale mode) — else the segment
  // stuck on Manual, no dirty, Save disabled.
  it("derives Skip when enabled:false even if a stale mode:manual lingers", () => {
    const cfg = { states: { tested: { mode: "manual", enabled: false } } } as PipelineConfig;
    expect(deriveCheckpointMode(cfg, "tested")).toBe("skip");
    expect(isCheckpointGated(cfg, "tested")).toBe(false);
  });

  it("round-trips Manual → Skip → Manual via applyCheckpointMode", () => {
    let cfg = { states: { tested: { mode: "manual", enabled: true } } } as PipelineConfig;
    expect(deriveCheckpointMode(cfg, "tested")).toBe("manual");

    cfg = applyCheckpointMode(cfg, "tested", "skip");
    expect(deriveCheckpointMode(cfg, "tested")).toBe("skip"); // the bug: used to stay "manual"

    cfg = applyCheckpointMode(cfg, "tested", "manual");
    expect(deriveCheckpointMode(cfg, "tested")).toBe("manual");
    expect(isCheckpointGated(cfg, "tested")).toBe(true);
  });

  it("manual is a gate; skip (enabled:false) is not", () => {
    expect(isCheckpointGated({ states: { tested: { mode: "manual", enabled: true } } } as PipelineConfig, "tested")).toBe(true);
    expect(isCheckpointGated({ states: { tested: { enabled: false } } } as PipelineConfig, "tested")).toBe(false);
  });
});

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
