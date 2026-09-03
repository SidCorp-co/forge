// @vitest-environment jsdom
//
// ISS-813 — this tab DISPLAYS states[*].disallowedTools and mcpServers, which
// were previously invisible and round-tripped blind. Displaying a value is
// worthless if the Save button next to it can still destroy it, so what is
// asserted here is that saving via the existing controls never drops a sibling
// key — including one no current schema knows about yet.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
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

const JOB_STAGES = ["open", "in_progress", "needs_info", "released"];
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

vi.mock("@/features/runners/hooks", () => ({
  useProjectRunners: () => ({ data: [], isPending: false }),
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
  states: {
    open: { enabled: true, mode: "auto", disallowedTools: DENYLIST_FULL },
    in_progress: {
      enabled: true,
      mode: "auto",
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
      mcpServers: { playwright: true },
    },
    needs_info: {
      enabled: true,
      mode: "auto",
      disallowedTools: DENYLIST_FULL,
      futureStageKnob: "stage-round-trips",
    },
    released: { enabled: true, mode: "manual", disallowedTools: DENYLIST_FULL },
  },
  someFutureKnob: "round-trips",
};

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <PipelineTab projectId="proj-1" canEdit={true} slug="forge-dev" />
      </ToastProvider>
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
  // cm:guard removing the `...cfg` / `...rest` spreads on the save path makes this pass for the wrong reason — delete one and watch this go red before trusting it green.
  it("flipping the master switch preserves every states[*] override and unknown keys", () => {
    renderTab();
    fireEvent.click(screen.getByRole("switch", { name: "Pipeline enabled" }));
    fireEvent.click(screen.getByRole("button", { name: /save pipeline config/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toEqual(DENYLIST_FULL);
    expect(states.in_progress.mcpServers).toEqual({ playwright: true });
    expect(states.needs_info.futureStageKnob).toBe("stage-round-trips");
    expect(sent.someFutureKnob).toBe("round-trips");
  });

  // cm:guard `released` carries `mode: 'manual'` in the fixture on purpose: the mode control is the one that used to REPLACE the whole state entry, so this is where a wholesale write would drop `disallowedTools` and nothing else would notice.
  it("switching a stage's mode preserves the rest of its entry", () => {
    renderTab();
    const row = stageRow("Awaiting release");
    fireEvent.click(within(row).getByRole("button", { name: "Auto" }));
    fireEvent.click(screen.getByRole("button", { name: /save pipeline config/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const released = (sent.states as Record<string, Record<string, unknown>>).released;
    expect(released.mode).toBe("auto");
    expect(released.disallowedTools).toEqual(DENYLIST_FULL);
  });
});
