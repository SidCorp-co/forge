// @vitest-environment jsdom
//
// Per-file jsdom opt-in: web-v2's vitest config stays `environment: 'node'`
// globally and matchers are extended on vitest's OWN `expect` — see the
// docblock on project-dashboard/awaiting-release-card.test.tsx for why.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    data: over === null ? undefined : { gateStatus: "tested", nextCutAt: null, channels: ["coolify"], releaseRunnerLabel: null, issues: [], ...over },
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
      <ReleaseGatePanel projectId="proj-1" slug="forge-dev" />
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

describe("ReleaseGatePanel — who deploys this", () => {
  it("names the project's live deploy target rather than saying nobody deploys it", () => {
    state({ channels: ["coolify"], issues: ISSUES });
    renderPanel();
    expect(screen.getByText("coolify")).toBeInTheDocument();
    expect(screen.queryByText("nothing — a person deploys")).not.toBeInTheDocument();
  });

  it("names every target where the project declares more than one", () => {
    state({ channels: ["coolify", "vercel"], issues: ISSUES });
    renderPanel();
    expect(screen.getByText("coolify")).toBeInTheDocument();
    expect(screen.getByText("vercel")).toBeInTheDocument();
  });

  it("says a person deploys this only where the roster names no target at all", () => {
    state({ channels: [], issues: ISSUES });
    renderPanel();
    expect(screen.getByText("nothing — a person deploys")).toBeInTheDocument();
  });

  it("shows the error state, and no sentence about deploying, when the response was refused", () => {
    state(null, {
      isError: true,
      error: new Error(
        "/projects/p1/release-batches/roster answered a release roster this app cannot read: channels should be an array of strings, and the response carries no such key.",
      ),
    });
    renderPanel();
    expect(screen.getByText("Couldn't load the release gate")).toBeInTheDocument();
    expect(screen.queryByText(/Deploys via/)).not.toBeInTheDocument();
    expect(screen.queryByText("nothing — a person deploys")).not.toBeInTheDocument();
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

describe("ReleaseGatePanel — the way in to a run that is shipping", () => {
  it("opens the run a claimed issue is shipping under", () => {
    state({ issues: ISSUES });
    renderPanel();
    const link = screen.getByRole("link", { name: "shipping now" });
    expect(link).toHaveAttribute("href", "/projects/forge-dev/releases/run-9");
  });

  it("leaves an unclaimed row as text, with no run to open", () => {
    state({ issues: [ISSUES[0]] });
    renderPanel();
    expect(screen.queryByRole("link", { name: "shipping now" })).not.toBeInTheDocument();
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

});

// An empty state costs what it is worth: a gate holding nothing is one line
// ahead of the list, never a card that pushes the first issue off the screen.
describe("ReleaseGatePanel — nothing is waiting", () => {
  it("is one line naming the gate and that nothing waits", () => {
    state({ issues: [] });
    renderPanel();
    const line = screen.getByRole("region", { name: "Awaiting release" });
    expect(line.className).toContain("h-10");
    expect(line).toHaveTextContent("None waiting");
  });

  it("offers no release action, no roster and no deploy sentence", () => {
    state({ issues: [], channels: ["coolify"] });
    renderPanel();
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("coolify")).not.toBeInTheDocument();
  });

  it("says when the next cut is, on the line itself", () => {
    state({ issues: [], nextCutAt: "2026-08-26T15:00:00.000Z" });
    renderPanel();
    const line = screen.getByRole("region", { name: "Awaiting release" });
    expect(within(line).getByText("Next cut in 3h")).toBeInTheDocument();
  });

  it("says a cut is due, in words that fit a phone, once its time has passed", () => {
    state({ issues: [], nextCutAt: "2026-08-26T11:00:00.000Z" });
    renderPanel();
    expect(screen.getByText("Cut due now")).toBeInTheDocument();
  });

  it("says a person releases where nothing is scheduled", () => {
    state({ issues: [], nextCutAt: null });
    renderPanel();
    expect(screen.getByText("A person releases")).toBeInTheDocument();
  });

  it("goes back to the full card the moment one issue is waiting", () => {
    state({ issues: ISSUES.slice(0, 1) });
    renderPanel();
    expect(screen.queryByRole("region", { name: "Awaiting release" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select ISS-1 for release" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /release now/i })).toBeInTheDocument();
  });
});
