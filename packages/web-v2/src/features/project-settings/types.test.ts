import { describe, expect, it } from "vitest";
import {
  denylistBaseline,
  humanizeToolName,
  type PipelineConfig,
  summarizeStageConfig,
} from "./types";

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
