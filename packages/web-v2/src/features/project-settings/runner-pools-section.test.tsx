// @vitest-environment jsdom
//
// The editor writes `states[*].deviceIds`, the only thing that narrows where a
// stage's jobs may land. Two things must hold, because the PATCH merge is
// wholesale-replace at the `states` key:
//  1. saving a pool never drops a sibling key on that state, nor a state the
//     editor does not surface at all;
//  2. clearing a pool DELETES the key (an empty array would read as "no device
//     is eligible" downstream), and un-pooled stages stay un-pooled.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunnerPoolsSection } from "./components/runner-pools-section";
import type { PipelineConfig } from "./types";

expect.extend(matchers);
afterEach(cleanup);

const mutate = vi.fn();
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useUpdatePipelineConfig: () => ({
      mutate,
      isPending: false,
      isError: false,
      isSuccess: false,
      error: null,
      reset: vi.fn(),
    }),
  };
});

const CX = "11111111-1111-4111-8111-111111111111";
const CLI = "22222222-2222-4222-8222-222222222222";

vi.mock("@/features/runners/hooks", () => ({
  useProjectRunners: () => ({
    data: [
      {
        runnerId: "r1",
        deviceId: CX,
        deviceName: "dev1 · cx",
        platform: "linux",
        deviceStatus: "online",
        deviceDisabledAt: null,
        runnerStatus: "online",
        lastError: null,
        limitReason: null,
      },
      {
        runnerId: "r2",
        deviceId: CLI,
        deviceName: "dev1 · CLI runner",
        platform: "linux",
        deviceStatus: "offline",
        deviceDisabledAt: null,
        runnerStatus: "offline",
        lastError: null,
        limitReason: null,
      },
    ],
    isPending: false,
  }),
}));

// cm:guard `released` is here to prove point 1: the editor does NOT surface it as a row, so a save that rebuilt `states` from the rows it renders would silently drop it.
const STORED: PipelineConfig = {
  enabled: true,
  states: {
    open: { enabled: true, mode: "auto", disallowedTools: ["CronCreate"] },
    in_progress: { enabled: true, mode: "auto", deviceIds: [CX] },
    released: { enabled: false, mode: "manual" },
  },
};

function renderSection(config: PipelineConfig = STORED, canEdit = true) {
  return render(<RunnerPoolsSection projectId="p1" config={config} canEdit={canEdit} />);
}

function cell(stageLabel: string, runnerName: string) {
  return screen.getByLabelText(`${stageLabel} on ${runnerName}`);
}

describe("RunnerPoolsSection", () => {
  beforeEach(() => mutate.mockClear());

  it("seeds from states[*].deviceIds", () => {
    renderSection();
    expect(cell("Running", "dev1 · cx")).toHaveAttribute("aria-pressed", "true");
    expect(cell("Running", "dev1 · CLI runner")).toHaveAttribute("aria-pressed", "false");
    expect(cell("Queued", "dev1 · cx")).toHaveAttribute("aria-pressed", "false");
  });

  it("adding a runner to a stage preserves every sibling key and every other state", () => {
    renderSection();
    fireEvent.click(cell("Queued", "dev1 · CLI runner"));
    fireEvent.click(screen.getByRole("button", { name: "Save runner pools" }));

    expect(mutate).toHaveBeenCalledTimes(1);
    const sent = mutate.mock.calls[0][0] as PipelineConfig;
    expect(sent.states?.open).toEqual({
      enabled: true,
      mode: "auto",
      disallowedTools: ["CronCreate"],
      deviceIds: [CLI],
    });
    expect(sent.states?.in_progress).toEqual({ enabled: true, mode: "auto", deviceIds: [CX] });
    expect(sent.states?.released).toEqual({ enabled: false, mode: "manual" });
    expect(sent.enabled).toBe(true);
  });

  it("clearing a pool deletes the key rather than sending an empty array", () => {
    renderSection();
    fireEvent.click(cell("Running", "dev1 · cx"));
    fireEvent.click(screen.getByRole("button", { name: "Save runner pools" }));

    const sent = mutate.mock.calls[0][0] as PipelineConfig;
    expect(sent.states?.in_progress).toEqual({ enabled: true, mode: "auto" });
    expect("deviceIds" in (sent.states?.in_progress ?? {})).toBe(false);
  });

  it("warns when every member of a pool is unavailable", () => {
    renderSection({ ...STORED, states: { in_progress: { deviceIds: [CLI] } } });
    expect(screen.getByText(/Whole pool unavailable/)).toBeInTheDocument();
  });

  it("blocks the save while a pool names a device with no runner here", () => {
    renderSection({ ...STORED, states: { in_progress: { deviceIds: ["33333333-3333-4333-8333-333333333333"] } } });
    fireEvent.click(cell("Queued", "dev1 · cx"));
    expect(screen.getByRole("button", { name: "Save runner pools" })).toBeDisabled();
  });

  it("renders no toggles and no save button without edit rights", () => {
    renderSection(STORED, false);
    expect(screen.queryByRole("button", { name: "Save runner pools" })).toBeNull();
    expect(cell("Running", "dev1 · cx")).toBeDisabled();
  });
});
