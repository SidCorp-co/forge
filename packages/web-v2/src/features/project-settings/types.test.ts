import { describe, expect, it } from "vitest";
import {
  applyCheckpointMode,
  denylistBaseline,
  deriveCheckpointMode,
  humanizeToolName,
  isCheckpointGated,
  type PipelineConfig,
  SESSION_GROUP_STAGES,
  summarizeStageConfig,
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

  it("Manual → Skip preserves disallowedTools and an unknown future key, dropping only mode", () => {
    let cfg = {
      states: {
        tested: {
          mode: "manual",
          enabled: true,
          disallowedTools: ["mcp__forge__forge_uploads"],
          futureKey: "round-trips",
        },
      },
    } as PipelineConfig;

    cfg = applyCheckpointMode(cfg, "tested", "skip");

    const tested = cfg.states!.tested!;
    expect(tested.enabled).toBe(false);
    expect(tested.mode).toBeUndefined();
    expect(tested.disallowedTools).toEqual(["mcp__forge__forge_uploads"]);
    expect(tested.futureKey).toBe("round-trips");
  });
});

describe("humanizeToolName", () => {
  it("de-prefixes and sentence-cases an mcp__<server>__<rest> id", () => {
    const h = humanizeToolName("mcp__forge__forge_projects_archive");
    expect(h).toEqual({ label: "Projects archive", server: "forge", raw: "mcp__forge__forge_projects_archive" });
  });

  it("keeps the rest as-is when it doesn't share the server's prefix", () => {
    const h = humanizeToolName("mcp__playwright__browser_click");
    expect(h).toEqual({ label: "Browser click", server: "playwright", raw: "mcp__playwright__browser_click" });
  });

  it("space-cases a bare PascalCase builtin", () => {
    expect(humanizeToolName("CronCreate")).toEqual({ label: "Cron create", server: null, raw: "CronCreate" });
    expect(humanizeToolName("RemoteTrigger")).toEqual({
      label: "Remote trigger",
      server: null,
      raw: "RemoteTrigger",
    });
    expect(humanizeToolName("Workflow")).toEqual({ label: "Workflow", server: null, raw: "Workflow" });
  });
});

describe("summarizeStageConfig / denylistBaseline", () => {
  const DENYLIST_FULL = [
    "mcp__forge__forge_projects_archive",
    "mcp__forge__forge_pm_set_dependency",
    "mcp__forge__forge_uploads",
    "CronCreate",
  ];

  const FORGE_DEV_SHAPED: PipelineConfig = {
    states: {
      open: { disallowedTools: DENYLIST_FULL },
      approved: { disallowedTools: DENYLIST_FULL },
      developed: { disallowedTools: DENYLIST_FULL },
      testing: { disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads") },
      clarified: { disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_pm_set_dependency") },
      confirmed: { disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads") },
      needs_info: {},
    },
  };

  it("omits a state with no permission-relevant override", () => {
    const rows = summarizeStageConfig(FORGE_DEV_SHAPED);
    expect(rows.some((r) => r.status === "needs_info")).toBe(false);
  });

  it("flags exactly the three stages that drift from the modal baseline", () => {
    const rows = summarizeStageConfig(FORGE_DEV_SHAPED);
    const diffs = denylistBaseline(rows);
    const outliers = diffs.filter((d) => d.isOutlier).map((d) => d.status);
    expect(outliers.sort()).toEqual(["clarified", "confirmed", "testing"]);
  });

  it("names the tool an outlier is allowed to use that the baseline denies", () => {
    const rows = summarizeStageConfig(FORGE_DEV_SHAPED);
    const diffs = denylistBaseline(rows);
    const testingDiff = diffs.find((d) => d.status === "testing")!;
    expect(testingDiff.missing).toEqual(["mcp__forge__forge_uploads"]);
    expect(testingDiff.extra).toEqual([]);
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
