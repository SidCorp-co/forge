import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as projectSettingsTypes from "./types";
import {
  API_ONLY_KEYS,
  denylistBaseline,
  groupByServer,
  humanizeToolName,
  knownToolIds,
  type PipelineConfig,
  type ProjectUpdateInput,
  summarizeStageConfig,
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
      in_progress: { disallowedTools: DENYLIST_FULL },
      awaiting_release: { disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads") },
      needs_info: {},
    },
  };

  it("omits a state with no permission-relevant override", () => {
    const rows = summarizeStageConfig(FORGE_DEV_SHAPED);
    expect(rows.some((r) => r.status === "needs_info")).toBe(false);
  });

  it("flags exactly the stage that drifts from the modal baseline", () => {
    const rows = summarizeStageConfig(FORGE_DEV_SHAPED);
    const diffs = denylistBaseline(rows);
    const outliers = diffs.filter((d) => d.isOutlier).map((d) => d.status);
    expect(outliers).toEqual(["awaiting_release"]);
  });

  it("names the tool an outlier is allowed to use that the baseline denies", () => {
    const rows = summarizeStageConfig(FORGE_DEV_SHAPED);
    const diffs = denylistBaseline(rows);
    const drifted = diffs.find((d) => d.status === "awaiting_release")!;
    expect(drifted.missing).toEqual(["mcp__forge__forge_uploads"]);
    expect(drifted.extra).toEqual([]);
  });

  it("renders no row for a status core would refuse to store", () => {
    const rows = summarizeStageConfig({
      states: { ...FORGE_DEV_SHAPED.states, clarified: { disallowedTools: DENYLIST_FULL } },
    });
    expect(rows.map((r) => r.status)).toEqual(["open", "in_progress", "awaiting_release"]);
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
          awaiting_release: { disallowedTools: ["CronCreate"], allowedTools: ["Bash"] },
        },
      }),
    ).toEqual(["Bash", "CronCreate", "Workflow"]);
  });
});

describe("withStagePatch", () => {
  const CFG: PipelineConfig = {
    enabled: true,
    states: {
      open: { disallowedTools: ["CronCreate"], sessionKnob: "keep" },
      awaiting_release: { model: "opus" },
    },
    topLevelKnob: "keep",
  };

  it("overrides only the named stage's named keys", () => {
    const next = withStagePatch(CFG, "open", { disallowedTools: ["Workflow"] });
    const states = next.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toEqual(["Workflow"]);
    expect(states.open.sessionKnob).toBe("keep");
    expect(states.awaiting_release).toEqual({ model: "opus" });
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
  it("promises no key to a closed issue and names no unread key", () => {
    for (const row of API_ONLY_KEYS) {
      expect(row.reason).not.toMatch(/ISS-814/);
      expect(row.key).not.toMatch(/recovery/i);
      expect(row.key).not.toMatch(/skipComplexities/);
      expect(row.key).not.toMatch(/skillName/);
      expect(row.key).not.toMatch(/stateContext/);
      expect(row.reason).not.toMatch(/per-jobType/i);
    }
  });
});

describe("the two retired knobs", () => {
  it("offers no stateContext on the update payload", () => {
    // @ts-expect-error ISS-1000 — core's PATCH /projects/:id refuses `stateContext` by name, so a payload type that still offered the field would compile a request that can only answer 400. This directive goes unused, and the build red, if the field comes back.
    const payload: ProjectUpdateInput = { stateContext: { code: { modelOverride: "opus" } } };
    expect(payload).toBeDefined();
  });

  it("exports no state-context value", () => {
    const exported = Object.keys(projectSettingsTypes).filter((k) => /state_?context/i.test(k));
    expect(exported).toEqual([]);
  });

  it("declares neither retired field, nor the type that described one", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "types.ts"), "utf8");
    for (const gone of [/\bskillName\b/, /\bstateContext\b/, /\bStateContextEntry\b/, /\bSTATE_CONTEXT_JOB_TYPES\b/]) {
      expect(source).not.toMatch(gone);
    }
  });
});
