// @vitest-environment jsdom
//
// ISS-1229 r48: with a project's runners unread, its pipeline settings said it had no runner, called every
// pinned pool "pinned to a device no runner answers for", and held Save for devices it had not read.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider, useSettingsForm } from "@/design";
import { readPipeline } from "../pipeline-form";

expect.extend(matchers);
afterEach(cleanup);

const refetch = vi.fn();
vi.mock("@/features/runners/hooks", async (importActual) => {
  const actual = await importActual<typeof import("@/features/runners/hooks")>();
  return {
    ...actual,
    useProjectRunners: () => ({
      data: undefined,
      isLoading: false,
      isPending: false,
      isError: true,
      error: new Error("The server is down."),
      refetch,
    }),
  };
});

const { RunnerPoolsSection, unknownPoolDevices } = await import("./runner-pools-section");
const { pipelineSaveHold } = await import("./pipeline-tab");

const PINNED = { states: { open: { deviceIds: ["d-1"] } } } as Parameters<typeof readPipeline>[0];

function Pools() {
  const form = useSettingsForm({ read: readPipeline(PINNED, []) });
  return <RunnerPoolsSection projectId="p1" form={form} canEdit />;
}

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeaveGuardProvider>
        <Pools />
      </LeaveGuardProvider>
    </QueryClientProvider>,
  );
}

describe("runner pools while the project's runners cannot be read", () => {
  it("never says the project has no runner", () => {
    draw();
    expect(screen.queryByText(/Pair a runner with this project first/)).toBeNull();
  });

  it("never calls a pinned pool pinned to a device no runner answers for", () => {
    draw();
    expect(screen.queryByText(/pinned to a device no runner answers for/)).toBeNull();
  });

  it("says the runners could not be loaded where the pools would be, and Retry reads them again", () => {
    draw();
    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load this project's runners. The server is down.");
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("names no device unknown, so Save is not held, while the runners are unread", () => {
    const { states } = readPipeline(PINNED, []);
    expect(unknownPoolDevices(states, null)).toEqual([]);
    expect(unknownPoolDevices(states, [])).toEqual(["d-1"]);
  });

  it("holds the page's Save for no device while the runners are unread, and for an unknown one once read", () => {
    const { states } = readPipeline(PINNED, []);
    expect(pipelineSaveHold({ states, runners: undefined, invalid: false })).toBeNull();
    expect(pipelineSaveHold({ states, runners: [], invalid: false })).toMatch(/names a device this project has no runner for/);
  });
});
