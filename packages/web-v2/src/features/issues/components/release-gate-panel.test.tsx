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
    closeRefusals: [],
    closeFailure: null,
    releaseRefusals: [],
  },
  {
    id: "iss-2",
    displayId: "ISS-2",
    title: "Dropdown renders flat",
    mergedAt: "2026-08-24T12:00:00.000Z",
    waitingDays: 2,
    claimedByRunId: null,
    closeRefusals: [],
    closeFailure: null,
    releaseRefusals: [],
  },
  {
    id: "iss-3",
    displayId: "ISS-3",
    title: "Favicon swap",
    mergedAt: "2026-08-26T11:00:00.000Z",
    waitingDays: 0,
    claimedByRunId: "run-9",
    closeRefusals: [],
    closeFailure: null,
    releaseRefusals: [],
  },
];

function state(over: Partial<ReleaseRoster> | null, flags: Record<string, unknown> = {}) {
  roster.mockReturnValue({
    data: over === null ? undefined : { gateStatus: "tested", nextCutAt: null, automaticRelease: false, channels: ["coolify"], releaseRunnerLabel: null, issues: [], blockingAll: [], ...over },
    isLoading: false,
    isError: false,
    error: null,
    refetch,
    ...flags,
  });
}

function renderPanel(canRelease = true) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ReleaseGatePanel projectId="proj-1" slug="forge-dev" canRelease={canRelease} />
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
    // ISS-1421 r6, criterion 97: the product's name, never its lower-case id.
    expect(screen.getByText("Deploys through Coolify.")).toBeInTheDocument();
    expect(screen.queryByText("coolify")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing deploys it: a person does.")).not.toBeInTheDocument();
  });

  it("names every target where the project declares more than one", () => {
    state({ channels: ["coolify", "epodsystem"], issues: ISSUES });
    renderPanel();
    expect(screen.getByText(/^Deploys through Coolify and /)).toBeInTheDocument();
  });

  it("says a person deploys this only where the roster names no target at all", () => {
    state({ channels: [], issues: ISSUES });
    renderPanel();
    expect(screen.getByText("Nothing deploys it: a person does.")).toBeInTheDocument();
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
    expect(screen.queryByText(/Deploys through/)).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing deploys it: a person does.")).not.toBeInTheDocument();
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

describe("ReleaseGatePanel — the way in to the release a claimed issue is in", () => {
  // ISS-1323: "shipping now" was false for a batch no box had started; the run screen says which.
  it("opens the run a claimed issue is in, without claiming it is shipping", () => {
    state({ issues: ISSUES });
    renderPanel();
    expect(screen.queryByText(/shipping now/)).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "in a release" });
    expect(link).toHaveAttribute("href", "/projects/forge-dev/releases/run-9");
  });

  it("leaves an unclaimed row as text, with no run to open", () => {
    state({ issues: [ISSUES[0]] });
    renderPanel();
    expect(screen.queryByRole("link", { name: "in a release" })).not.toBeInTheDocument();
  });
});

describe("ReleaseGatePanel — releasing", () => {
  // ISS-1300 r5 (judge-125, X2): the release door takes a project admin, so nobody else is offered it.
  it("offers no Release now to a reader who may not release, and names who may", () => {
    state({ issues: ISSUES });
    renderPanel(false);
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("Only an admin of this project can release these issues, so ask one of them."),
    ).toBeInTheDocument();
  });

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
    expect(screen.getByText(/1 in a release/)).toBeInTheDocument();
  });

});

// ISS-1337: a row the release could not close is named before the press, never offered for one.
describe("ReleaseGatePanel — a row a release could not close", () => {
  const REFUSED: ReleaseRoster["issues"][number] = {
    id: "iss-4",
    displayId: "ISS-4",
    title: "Seven jerseys back in the store",
    mergedAt: "2026-08-26T10:00:00.000Z",
    waitingDays: 0,
    claimedByRunId: null,
    closeRefusals: [
      {
        code: "CLOSE_REQUIRES_SHIPPED",
        reason: "no mark naming where its work landed",
        clears: "Mark it merged with its landing.",
        said: "It has no mark naming where its work landed. Mark it merged with its landing.",
        saidHere: "It has no mark naming where its work landed. Mark it merged with its landing.",
      },
    ],
    closeFailure: null,
    releaseRefusals: [],
  };

  it("cannot be selected, and says on its row what the close is refused for and what clears it", () => {
    state({ issues: [...ISSUES, REFUSED] });
    renderPanel();
    expect(screen.getByRole("checkbox", { name: "Select ISS-4 for release" })).toBeDisabled();
    expect(screen.getByText("Not ready to release")).toBeInTheDocument();
    expect(screen.queryByText(/can't close/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "It has no mark naming where its work landed. Mark it merged with its landing.",
      ),
    ).toBeInTheDocument();
  });

  it("is left out of select-all, the ready count and the dialog", () => {
    state({ issues: [...ISSUES, REFUSED] });
    renderPanel();
    expect(screen.getByText(/2 ready · 1 in a release · 1 not ready to release/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every issue that can be released" }));
    fireEvent.click(screen.getByRole("button", { name: /^Release 2 now$/ }));
    expect(dialogProps?.selectedIssues.map((i) => i.displayId)).toEqual(["ISS-1", "ISS-2"]);
  });

  // r36, judge-145: with 0 ready the gate still offered a Release now nothing could enable. It offers
  // none, and says what would make an issue ready.
  it("offers no Release now when no waiting row can be released, and says where to read what would", () => {
    state({ issues: [REFUSED] });
    renderPanel();
    expect(screen.getByRole("checkbox", { name: "Select every issue that can be released" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("None is ready to release. Each issue marked Not ready to release says below what would make it ready."),
    ).toBeInTheDocument();
    cleanup();
    state({ issues: [REFUSED, ISSUES[2]] });
    renderPanel(false);
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("none-ready")).toHaveTextContent(
      "None is ready to release. Each issue marked Not ready to release says below what would make it ready, and the rest are already in a release.",
    );
    cleanup();
    state({ issues: [ISSUES[2]] });
    renderPanel();
    expect(screen.getByText("None is ready to release: the one waiting is already in a release.")).toBeInTheDocument();
  });
});

// ISS-1381 r4: a release would meet the same fault again, so the row says so before the press.
describe("ReleaseGatePanel — a row whose last release failed its close", () => {
  const FAILED: ReleaseRoster["issues"][number] = {
    id: "iss-7",
    displayId: "ISS-7",
    title: "Ledger rows carry their tenant",
    mergedAt: "2026-08-26T10:00:00.000Z",
    waitingDays: 0,
    claimedByRunId: null,
    closeRefusals: [],
    closeFailure: { reason: "the database refused the write (23514)", version: "0.6.0" },
    releaseRefusals: [],
  };

  it("stays selectable and says on its row that a release fails the same way until it is fixed", () => {
    state({ issues: [...ISSUES, FAILED] });
    renderPanel();
    expect(screen.getByRole("checkbox", { name: "Select ISS-7 for release" })).not.toBeDisabled();
    expect(
      screen.getByText(
        "The last release (version 0.6.0) could not close this: the database refused the write (23514). A release fails the same way until whoever operates Forge fixes it.",
      ),
    ).toBeInTheDocument();
  });

  // ISS-1381 r5: a row a release fails the same way is not ready, and the dialog is told why.
  it("is left out of the ready count and select-all, and counted as the last release failed it", () => {
    state({ issues: [...ISSUES, FAILED] });
    renderPanel();
    expect(
      screen.getByText(/2 ready · 1 in a release · 1 the last release failed to close/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every issue that can be released" }));
    fireEvent.click(screen.getByRole("button", { name: /^Release 2 now$/ }));
    expect(dialogProps?.selectedIssues.map((i) => i.displayId)).toEqual(["ISS-1", "ISS-2"]);
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

  // ISS-1421 r13 — judge-58 read "a person releases this" on a project whose automatic release was
  // writing hold comments on the very issues the panel listed.
  it("says the gate releases on its own where the automatic release is on", () => {
    state({ issues: [], nextCutAt: null, automaticRelease: true });
    renderPanel();
    expect(screen.getByText("Releases on its own")).toBeInTheDocument();
    expect(screen.queryByText("A person releases")).not.toBeInTheDocument();
  });

  it("names the automatic release, never a person, over a waiting roster", () => {
    state({ issues: ISSUES.slice(0, 1), nextCutAt: null, automaticRelease: true });
    renderPanel();
    expect(
      screen.getByText(/Forge releases each one on its own once its criteria pass and nothing holds it/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/a person releases this/)).not.toBeInTheDocument();
  });

  it("still says a person releases a waiting roster where nothing else will", () => {
    state({ issues: ISSUES.slice(0, 1), nextCutAt: null, automaticRelease: false });
    renderPanel();
    expect(screen.getByText(/No schedule — a person releases this/)).toBeInTheDocument();
  });

  it("goes back to the full card the moment one issue is waiting", () => {
    state({ issues: ISSUES.slice(0, 1) });
    renderPanel();
    expect(screen.queryByRole("region", { name: "Awaiting release" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select ISS-1 for release" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /release now/i })).toBeInTheDocument();
  });
});

// ISS-1421 r6 repair: the panel was a rounded, bordered card above a flush table (owner rule: flat).
describe("ReleaseGatePanel — laid out flat", () => {
  it.each([
    ["the roster", () => state({ issues: ISSUES })],
    ["its loading state", () => state(null, { isLoading: true })],
    ["its error state", () => state(null, { isError: true, error: new Error("gateway timed out") })],
  ])("draws %s with hairlines, and no card surface", (_name, arrange) => {
    arrange();
    const { container } = renderPanel();
    expect(container.querySelector(".shadow-sm")).toBeNull();
    expect(container.querySelector(".rounded-lg.border")).toBeNull();
    expect(container.querySelector("section.border-y")).not.toBeNull();
  });
});

// ISS-1421 r37, judge-151 on criteria 366 and 367: a project whose only waiting issue had no release
// note read "1 ready" and offered Release now, which the create door then refused. A row is ready only
// where the press over it would not be refused.
describe("ReleaseGatePanel — ready means Release now is not refused", () => {
  const UNNOTED: ReleaseRoster["issues"][number] = {
    id: "iss-5",
    displayId: "ISS-5",
    title: "Invoices show the tax line",
    mergedAt: "2026-08-26T10:00:00.000Z",
    waitingDays: 0,
    claimedByRunId: null,
    closeRefusals: [],
    closeFailure: null,
    releaseRefusals: [
      {
        code: "RELEASE_RECORD_MISSING",
        said: "It has no release note. It needs one before it can be released.",
        saidHere: "This issue has no release note. It needs one before it can be released.",
      },
    ],
  };

  it("offers no Release now over a lone issue with no release note, and says on its row what makes it ready", () => {
    state({ issues: [UNNOTED] });
    renderPanel();
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select ISS-5 for release" })).toBeDisabled();
    expect(screen.getByText(/^0 ready · 1 not ready to release$/)).toBeInTheDocument();
    expect(screen.getByText("Not ready to release")).toBeInTheDocument();
    expect(screen.getByText("It has no release note. It needs one before it can be released.")).toBeInTheDocument();
    expect(screen.getByTestId("none-ready")).toHaveTextContent(
      "None is ready to release. Each issue marked Not ready to release says below what would make it ready.",
    );
  });

  it("leaves a row with no release note out of select-all and the dialog", () => {
    state({ issues: [ISSUES[0] as ReleaseRoster["issues"][number], UNNOTED] });
    renderPanel();
    expect(screen.getByText(/^1 ready · 1 not ready to release$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every issue that can be released" }));
    fireEvent.click(screen.getByRole("button", { name: /^Release 1 now$/ }));
    expect(dialogProps?.selectedIssues.map((i) => i.displayId)).toEqual(["ISS-1"]);
  });

  it("offers no Release now where every pick would be refused, and says why and what clears it", () => {
    const blockingAll = [
      { code: "RELEASE_POOL_EMPTY", said: "This project has no runner registered, so there is no box a release could run on. Pair a box to this project first.", runId: null },
    ];
    state({ issues: ISSUES, blockingAll });
    renderPanel();
    expect(screen.queryByRole("button", { name: /release/i })).not.toBeInTheDocument();
    expect(screen.getByTestId("none-ready")).toHaveTextContent(
      "None can be released yet. This project has no runner registered, so there is no box a release could run on. Pair a box to this project first.",
    );
    expect(screen.getByRole("checkbox", { name: "Select ISS-1 for release" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Select every issue that can be released" })).toBeDisabled();
    expect(screen.getByText(/^0 ready · 1 in a release · 2 not ready to release$/)).toBeInTheDocument();
  });

  // ISS-1421 r39, judge-160: with no runner the gate read "0 ready · 1 not ready to release" over
  // four rows, counting only the row refused for its own note.
  it("counts every row a shared reason holds as not ready, so the counts add up to the rows", () => {
    const blockingAll = [
      { code: "RELEASE_POOL_EMPTY", said: "This project has no runner registered.", runId: null },
    ];
    state({ issues: [...ISSUES, UNNOTED], blockingAll });
    renderPanel();
    expect(screen.getAllByRole("listitem")).toHaveLength(ISSUES.length + 1);
    expect(screen.getByText(/^0 ready · 1 in a release · 3 not ready to release$/)).toBeInTheDocument();
  });

  // ISS-1421 r38, judge-155: the gate said a running release would claim the same issues, told a
  // person to abort it, and linked to no run; the web has no abort.
  it("links the running release where one running is why none can be released", () => {
    const blockingAll = [
      {
        code: "BATCH_IN_FLIGHT",
        said: "A release is already running for this project, carrying ISS-3. A project runs one release at a time, so ISS-1 and ISS-2 are on no release and wait until it finishes.",
        runId: "run-9",
      },
    ];
    state({ issues: ISSUES, blockingAll });
    renderPanel();
    const line = screen.getByTestId("none-ready");
    expect(line).toHaveTextContent(/carrying ISS-3\. .* wait until it finishes\. Open the running release$/);
    expect(line).not.toHaveTextContent(/abort/i);
    expect(within(line).getByRole("link", { name: "Open the running release" })).toHaveAttribute(
      "href",
      "/projects/forge-dev/releases/run-9",
    );
  });

  it("shows a stored value core still marks as code, never a backtick", () => {
    state({ issues: ISSUES, blockingAll: [{ code: "RELEASE_PROBES_UNREADABLE", said: "The live deploy target `coolify-a` declares a verify step.", runId: null }] });
    renderPanel();
    const line = screen.getByTestId("none-ready");
    expect(line).not.toHaveTextContent("`");
    expect(within(line).getByText("coolify-a").tagName).toBe("CODE");
    expect(within(line).queryByRole("link")).toBeNull();
  });
});
