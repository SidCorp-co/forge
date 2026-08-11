// @vitest-environment jsdom
//
// ISS-813 — this tab now DISPLAYS states[*].disallowedTools/sessionGroup/
// mcpServers/skipComplexities (previously invisible, previously round-tripped
// blind). Displaying a value is worthless if the Save button next to it can
// still destroy it — the ISS-767 pattern, applied here. Two things must hold:
//  1. saving via the EXISTING controls (master enabled, per-stage mode) never
//     drops a sibling key, including one no current schema knows about yet;
//  2. the `tested` checkpoint's Manual→Skip control, which used to REPLACE the
//     whole state entry (deleting its disallowedTools), now preserves it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineTab } from "./components/pipeline-tab";
import type { PipelineConfig } from "./types";

expect.extend(matchers);

const mutate = vi.fn();
// cm:guard usePipelineConfig().data must be the SAME object reference across renders — pipeline-tab.tsx's `useEffect(() => setDraft(cfgQ.data.pipelineConfig), [cfgQ.data])` re-seeds `draft` from a fresh reference, silently discarding any in-progress edit (toggle/mode click) before Save ever reads it
let pipelineData: { pipelineConfig: PipelineConfig } | undefined;
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    usePipelineConfig: () => ({
      data: (pipelineData ??= { pipelineConfig: STORED }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useUpdatePipelineConfig: () => ({ mutate, isPending: false, isError: false, error: null, reset: vi.fn() }),
  };
});

const JOB_STAGES = ["open", "confirmed", "clarified", "approved", "developed", "testing", "reopen", "released"];
vi.mock("@/features/skills/hooks", () => ({
  useSkills: () => ({ data: [], isLoading: false }),
  useSkillRegistrations: () => ({
    data: { registrations: JOB_STAGES.map((stage) => ({ stage, skillId: `skill-${stage}` })) },
    isLoading: false,
  }),
  useRegisterSkill: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUnregisterSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useAdoptSkill: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { agentConfig: {} }, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const DENYLIST_FULL = [
  "mcp__forge__forge_projects_archive",
  "mcp__forge__forge_pm_set_dependency",
  "mcp__forge__forge_uploads",
  "mcp__forge__forge_memory_write",
  "CronCreate",
];

const STORED: PipelineConfig = {
  enabled: true,
  autoTriage: true,
  autoClarify: true,
  autoPlan: true,
  autoCode: true,
  autoReview: true,
  autoTest: true,
  autoFix: true,
  autoRelease: true,
  states: {
    open: { enabled: true, mode: "auto", disallowedTools: DENYLIST_FULL, sessionGroup: "planning" },
    confirmed: {
      enabled: true,
      mode: "auto",
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
      skipComplexities: ["xs", "s"],
      sessionGroup: "planning",
    },
    clarified: {
      enabled: true,
      mode: "auto",
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_pm_set_dependency"),
      mcpServers: { playwright: true },
      sessionGroup: "planning",
    },
    approved: {
      enabled: true,
      mode: "auto",
      disallowedTools: DENYLIST_FULL,
      sessionGroup: "build",
      futureStageKnob: "stage-round-trips",
    },
    developed: { enabled: true, mode: "auto", disallowedTools: DENYLIST_FULL, sessionGroup: "build" },
    testing: {
      enabled: true,
      mode: "auto",
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
      mcpServers: { playwright: true },
      sessionGroup: "build",
    },
    tested: { enabled: true, mode: "manual", disallowedTools: DENYLIST_FULL },
    reopen: { enabled: true, mode: "auto", disallowedTools: DENYLIST_FULL },
    released: { enabled: true, mode: "auto", disallowedTools: DENYLIST_FULL, sessionGroup: "build" },
  },
  sessionGroups: {
    planning: ["open", "confirmed", "clarified"],
    build: ["approved", "developed", "testing", "released"],
  },
  someFutureKnob: "round-trips",
};

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <PipelineTab projectId="proj-1" canEdit={true} slug="forge-dev" />
    </QueryClientProvider>,
  );
}

// cm:guard scope to the <p> a StageRow renders — the same label also renders as a <span> inside StagePermissionsSection's collapsible title, so an unscoped query matches both
function stageRow(label: string): HTMLElement {
  const heading = screen.getByText(label, { selector: "p" });
  const row = heading.closest("div")?.parentElement;
  if (!row) throw new Error(`Stage row for "${label}" not found`);
  return row as HTMLElement;
}

beforeEach(() => {
  mutate.mockClear();
});
afterEach(cleanup);

describe("Pipeline tab · preserve-on-save (ISS-813, ISS-767 pattern)", () => {
  it("flipping the master switch preserves every states[*] override and unknown keys", () => {
    renderTab();
    fireEvent.click(screen.getByRole("switch", { name: "Pipeline enabled" }));
    fireEvent.click(screen.getByRole("button", { name: /save pipeline config/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toEqual(DENYLIST_FULL);
    expect(states.confirmed.skipComplexities).toEqual(["xs", "s"]);
    expect(states.clarified.mcpServers).toEqual({ playwright: true });
    expect(states.open.sessionGroup).toBe("planning");
    expect(states.approved.futureStageKnob).toBe("stage-round-trips");
    expect(sent.someFutureKnob).toBe("round-trips");
  });

  // cm:guard removing the `...cfg`/`...rest` spreads on the save path (here or in applyCheckpointMode) makes this pass for the wrong reason — verify a spread removal actually fails this test before trusting it green
  it("tested Manual → Skip preserves disallowedTools and clears mode (not a wholesale replace)", () => {
    renderTab();
    const row = stageRow("Awaiting release");
    fireEvent.click(within(row).getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: /save pipeline config/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const tested = (sent.states as Record<string, Record<string, unknown>>).tested;
    expect(tested.enabled).toBe(false);
    expect(tested.mode).toBeUndefined();
    expect(tested.disallowedTools).toEqual(DENYLIST_FULL);
  });
});
