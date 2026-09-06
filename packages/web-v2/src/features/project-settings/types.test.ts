import { describe, expect, it } from "vitest";
import {
  API_ONLY_KEYS,
  denylistBaseline,
  groupByServer,
  humanizeToolName,
  knownToolIds,
  type PipelineConfig,
  summarizeStageConfig,
  validateBudget,
  withStagePatch,
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

describe("groupByServer", () => {
  it("buckets by MCP server and files builtins under Built-in", () => {
    expect(
      groupByServer(["mcp__forge__forge_issues", "CronCreate", "mcp__forge__forge_uploads"]),
    ).toEqual([
      ["forge", ["mcp__forge__forge_issues", "mcp__forge__forge_uploads"]],
      ["Built-in", ["CronCreate"]],
    ]);
  });
});

describe("knownToolIds", () => {
  it("unions allow and deny lists across every stage, sorted and deduped", () => {
    expect(
      knownToolIds({
        states: {
          open: { disallowedTools: ["CronCreate", "Workflow"] },
          released: { disallowedTools: ["CronCreate"], allowedTools: ["Bash"] },
        },
      }),
    ).toEqual(["Bash", "CronCreate", "Workflow"]);
  });
});

describe("validateBudget", () => {
  it("takes an entirely absent budget", () => {
    expect(validateBudget({})).toEqual([]);
  });

  it("takes a complete budget inside the caps", () => {
    expect(validateBudget({ perRunUsd: 5, perMonthUsd: 100, action: "warn" })).toEqual([]);
  });

  // cm:guard core's budgetSchema is `.strict()` with all three keys required, so a partial budget is a 400 rather than a smaller cap — this is the assertion that would go red if the all-or-nothing check were relaxed to per-field.
  it("refuses a budget carrying only some of its three keys", () => {
    expect(validateBudget({ perRunUsd: 5 })).toContain(
      "A budget needs all three of per-run, per-month and action.",
    );
    expect(validateBudget({ perRunUsd: 5, perMonthUsd: 10 })).toContain(
      "A budget needs all three of per-run, per-month and action.",
    );
  });

  it("refuses values outside the caps core would take", () => {
    expect(validateBudget({ perRunUsd: 1001, perMonthUsd: 10, action: "warn" })).toEqual([
      "Per-run must be between 0 and 1000.",
    ]);
    expect(validateBudget({ perRunUsd: 1, perMonthUsd: 100001, action: "pause" })).toEqual([
      "Per-month must be between 0 and 100000.",
    ]);
  });
});

describe("withStagePatch", () => {
  const CFG: PipelineConfig = {
    enabled: true,
    states: {
      open: { disallowedTools: ["CronCreate"], sessionKnob: "keep" },
      released: { mode: "manual" },
    },
    topLevelKnob: "keep",
  };

  it("overrides only the named stage's named keys", () => {
    const next = withStagePatch(CFG, "open", { disallowedTools: ["Workflow"] });
    const states = next.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toEqual(["Workflow"]);
    expect(states.open.sessionKnob).toBe("keep");
    expect(states.released).toEqual({ mode: "manual" });
    expect(next.topLevelKnob).toBe("keep");
    expect(next.enabled).toBe(true);
  });

  it("creates a stage that had no entry, without disturbing the others", () => {
    const next = withStagePatch(CFG, "needs_info", { mcpServers: { playwright: true } });
    const states = next.states as Record<string, Record<string, unknown>>;
    expect(states.needs_info).toEqual({ mcpServers: { playwright: true } });
    expect(states.open.sessionKnob).toBe("keep");
  });

  it("does not mutate the config it was given", () => {
    const before = JSON.stringify(CFG);
    withStagePatch(CFG, "open", { disallowedTools: [] });
    expect(JSON.stringify(CFG)).toBe(before);
  });
});

describe("API_ONLY_KEYS", () => {
  // cm:guard a row here is a promise to an operator that the key exists and is set elsewhere. ISS-814 removed the `recovery*` row because nothing in core reads those keys, and the rows that pointed at ISS-814 because that issue closed without them — a row naming work that will not happen is the same defect as no row.
  it("promises no key to a closed issue and names no unread key", () => {
    for (const row of API_ONLY_KEYS) {
      expect(row.reason).not.toMatch(/ISS-814/);
      expect(row.key).not.toMatch(/recovery/i);
      expect(row.key).not.toMatch(/skipComplexities/);
    }
  });
});
