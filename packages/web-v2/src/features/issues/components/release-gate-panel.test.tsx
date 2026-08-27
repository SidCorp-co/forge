// @vitest-environment jsdom
//
// Per-file jsdom opt-in: web-v2's vitest config stays `environment: 'node'`
// globally and matchers are extended on vitest's OWN `expect` — see the
// docblock on project-dashboard/awaiting-release-card.test.tsx for why.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseRoster } from "../api";
import { ReleaseGatePanel } from "./release-gate-panel";

expect.extend(matchers);

const roster = vi.fn();
const refetch = vi.fn();
vi.mock("../hooks", () => ({
  useReleaseRoster: () => roster(),
}));

let dialogProps: { open: boolean; selectedIssues: Array<{ displayId: string }> } | null = null;
const mutate = vi.fn();
vi.mock("./batch-release-dialog", () => ({
  BatchReleaseDialog: (props: { open: boolean; selectedIssues: Array<{ displayId: string }> }) => {
    dialogProps = props;
    return null;
  },
}));

const NOW = new Date("2026-08-26T12:00:00.000Z");

/** Deliberately NOT in merge order — the oldest sits second (see the oldest test). */
const ISSUES: ReleaseRoster["issues"] = [
  {
    id: "iss-1",
    displayId: "ISS-1",
    title: "Signup accepts a plan that is not sold",
    mergedAt: "2026-08-26T09:00:00.000Z",
    waitingDays: 0,
    claimedByRunId: null,
  },
  {
    id: "iss-2",
    displayId: "ISS-2",
    title: "Dropdown renders flat",
    mergedAt: "2026-08-24T12:00:00.000Z",
    waitingDays: 2,
    claimedByRunId: null,
  },
  {
    id: "iss-3",
    displayId: "ISS-3",
    title: "Favicon swap",
    mergedAt: "2026-08-26T11:00:00.000Z",
    waitingDays: 0,
    claimedByRunId: "run-9",
  },
];

function state(over: Partial<ReleaseRoster> | null, flags: Record<string, unknown> = {}) {
  roster.mockReturnValue({
    data: over === null ? undefined : { gateStatus: "tested", nextCutAt: null, channel: "coolify", releaseRunnerLabel: null, issues: [], ...over },
    isLoading: false,
    isError: false,
    error: null,
    refetch,
    ...flags,
  });
}

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ReleaseGatePanel projectId="proj-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dialogProps = null;
  refetch.mockClear();
  mutate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ReleaseGatePanel — the three unknowns render differently", () => {
  it("shows a skeleton while loading instead of collapsing to nothing", () => {
    state(null, { isLoading: true });
    const { container } = renderPanel();
    expect(container.querySelector("[aria-busy='true']")).toBeInTheDocument();
    expect(screen.queryByText("Awaiting release")).not.toBeInTheDocument();
  });

  it("shows a retryable error instead of collapsing to nothing", () => {
    state(null, { isError: true, error: new Error("gateway timed out") });
    renderPanel();
    expect(screen.getByText("Couldn't load the release gate")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when the project genuinely has no release gate", () => {
    state({ gateStatus: null });
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ReleaseGatePanel — merge age", () => {
  it("reports each row's real merge age rather than a day count that floors to 0", () => {
    state({ issues: ISSUES });
    renderPanel();
    expect(screen.getByText("merged 3h ago")).toBeInTheDocument();
    expect(screen.getByText("merged 2d ago")).toBeInTheDocument();
    expect(screen.queryByText(/waiting 0d/)).not.toBeInTheDocument();
  });

  it("names the oldest merge from the whole roster, not from whichever row arrived first", () => {
    state({ issues: ISSUES });
    renderPanel();
    expect(screen.getByText(/oldest merged 2d ago/)).toBeInTheDocument();
  });
});

describe("ReleaseGatePanel — releasing", () => {
  it("keeps the action disabled, and says why, until something is selected", () => {
    state({ issues: ISSUES });
    renderPanel();
    const btn = screen.getByRole("button", { name: /^Release now$/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Select at least one issue to release");
  });

  it("confirms through the dialog rather than releasing straight from the button", () => {
    state({ issues: ISSUES });
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select ISS-1 for release" }));
    fireEvent.click(screen.getByRole("button", { name: /^Release 1 now$/ }));
    expect(mutate).not.toHaveBeenCalled();
    expect(dialogProps?.open).toBe(true);
    expect(dialogProps?.selectedIssues.map((i) => i.displayId)).toEqual(["ISS-1"]);
  });

  it("select-all takes every releasable issue and leaves a claimed one alone", () => {
    state({ issues: ISSUES });
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every issue that can be released" }));
    fireEvent.click(screen.getByRole("button", { name: /^Release 2 now$/ }));
    expect(dialogProps?.selectedIssues.map((i) => i.displayId)).toEqual(["ISS-1", "ISS-2"]);
    expect(screen.getByRole("checkbox", { name: "Select ISS-3 for release" })).toBeDisabled();
    expect(screen.getByText(/1 shipping now/)).toBeInTheDocument();
  });

  it("offers an empty state when the gate exists but nothing is waiting", () => {
    state({ issues: [] });
    renderPanel();
    expect(screen.getByText("Nothing is waiting")).toBeInTheDocument();
  });
});
