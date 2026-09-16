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

const JOB_STAGES = ["open", "in_progress", "needs_info", "awaiting_release"];
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

const PROJECT_DATA = { agentConfig: {} };
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: PROJECT_DATA, isLoading: false, isError: false, refetch: vi.fn() }),
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
      model: "sonnet",
      disallowedTools: DENYLIST_FULL.filter((t) => t !== "mcp__forge__forge_uploads"),
      mcpServers: { playwright: true },
    },
    needs_info: {
      enabled: true,
      model: "sonnet",
      disallowedTools: DENYLIST_FULL,
      futureStageKnob: "stage-round-trips",
    },
    awaiting_release: { enabled: true, model: "opus", disallowedTools: DENYLIST_FULL },
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
    expect(states.in_progress.mcpServers).toEqual({ playwright: true });
    expect(states.needs_info.futureStageKnob).toBe("stage-round-trips");
    expect(sent.someFutureKnob).toBe("round-trips");
  });

  it("closing the entry gate writes both knobs and preserves the rest of that stage", () => {
    renderTab();
    fireEvent.click(screen.getByRole("switch", { name: "Start queued issues automatically" }));
    fireEvent.click(screen.getByRole("button", { name: /save pipeline config/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const open = (sent.states as Record<string, Record<string, unknown>>).open;
    expect(open.enabled).toBe(false);
    expect(open.mode).toBe("manual");
    expect(open.disallowedTools).toEqual(DENYLIST_FULL);
    expect((sent.states as Record<string, Record<string, unknown>>).awaiting_release.disallowedTools).toEqual(
      DENYLIST_FULL,
    );
  });

  it("saving one stage preserves the other stages, the unknown keys and its own untouched keys", () => {
    renderTab();
    fireEvent.click(screen.getByText("in_progress").closest("button") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Remove Cron create" }));
    fireEvent.click(screen.getByRole("button", { name: /save running permissions/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.open.disallowedTools).toEqual(DENYLIST_FULL);
    expect(states.needs_info.futureStageKnob).toBe("stage-round-trips");
    expect(states.awaiting_release.model).toBe("opus");
    expect(sent.someFutureKnob).toBe("round-trips");
    expect(states.in_progress.enabled).toBe(true);
    expect(states.in_progress.model).toBe("sonnet");
    expect(states.in_progress.mcpServers).toEqual({ playwright: true });
    expect(states.in_progress.disallowedTools).not.toContain("CronCreate");
  });

  it("saving a stage's per-state MCP override leaves its tool lists alone", () => {
    renderTab();
    fireEvent.click(screen.getByText("needs_info").closest("button") as HTMLElement);
    const row = screen.getByText(/Playwright —/).closest("label") as HTMLElement;
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /save needs a human permissions/i }));

    const sent = mutate.mock.calls[0]?.[0] as PipelineConfig;
    const states = sent.states as Record<string, Record<string, unknown>>;
    expect(states.needs_info.mcpServers).toEqual({ playwright: true });
    expect(states.needs_info.disallowedTools).toEqual(DENYLIST_FULL);
    expect(states.needs_info.futureStageKnob).toBe("stage-round-trips");
    expect(states.open.disallowedTools).toEqual(DENYLIST_FULL);
  });

  it("reads a stage held by `mode` alone as closed", () => {
    pipelineData = {
      pipelineConfig: {
        ...STORED,
        states: { ...STORED.states, open: { mode: "manual", disallowedTools: DENYLIST_FULL } },
      } as PipelineConfig,
    };
    renderTab();
    expect(screen.getByRole("switch", { name: "Start queued issues automatically" })).not.toBeChecked();
    pipelineData = { pipelineConfig: STORED };
  });
});
