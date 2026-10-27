// @vitest-environment jsdom
//
// Per-file jsdom opt-in — see the docblock on
// project-dashboard/awaiting-release-card.test.tsx for why the shared config
// stays `environment: 'node'`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseRoster } from "../api";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";

expect.extend(matchers);

const roster = vi.fn();
const release = vi.fn();
vi.mock("../hooks", () => ({
  useReleaseRoster: () => roster(),
  useBatchRelease: () => ({ mutate: release, isPending: false }),
}));

const NOW = new Date("2026-08-26T12:00:00.000Z");

function state(
  over: Partial<ReleaseRoster>,
  claimed: string | null = null,
  closeRefusals: ReleaseRoster["issues"][number]["closeRefusals"] = [],
  closeFailure: ReleaseRoster["issues"][number]["closeFailure"] = null,
  releaseRefusals: ReleaseRoster["issues"][number]["releaseRefusals"] = [],
) {
  roster.mockReturnValue({
    data: {
      gateStatus: "tested",
      nextCutAt: null,
      automaticRelease: false,
      channels: ["coolify"],
      releaseRunnerLabel: null,
      baseBranch: "main",
      issues: [
        {
          id: "iss-1",
          displayId: "ISS-1",
          title: "A thing",
          mergedAt: "2026-08-26T09:00:00.000Z",
          waitingDays: 0,
          claimedByRunId: claimed,
          closeRefusals,
          closeFailure,
          releaseRefusals,
        },
      ],
      blockingAll: [],
      ...over,
    },
  });
}

const renderBanner = (canWrite = true) =>
  render(<AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease={canWrite} />);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AwaitingReleaseBanner", () => {
  it("dates the merge to the hour rather than rounding a same-day merge to 'today'", () => {
    state({});
    renderBanner();
    expect(screen.getByText(/Merged into main 3h ago/)).toBeInTheDocument();
  });

  // ISS-1421 r14 — judge-61 read "Merged into main" over a mark that was only a claim naming no commit.
  it("says a mark that is only a claim is claimed, never merged into the base branch", () => {
    state({});
    render(<AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease mergeMark="asserted" />);
    expect(screen.getByText(/Claimed as merged 3h ago, naming no commit — not shipped yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/Merged into/)).not.toBeInTheDocument();
  });

  // ISS-1300 r3: a person's mark naming a commit the repository holds read "naming no commit".
  it("names the commit a claim carries, and whether the repository was asked about it", () => {
    state({});
    const sha = "0d018a9ac5897cd4ef3fe299f9c13e4c252162e2";
    const { unmount } = render(
      <AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease mergeMark="asserted" mergedCommitSha={sha} />,
    );
    expect(screen.getByText(/Claimed as merged at 0d018a9 3h ago, a commit the repository holds/)).toBeInTheDocument();
    unmount();
    render(
      <AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease mergeMark="asserted" mergedClaimedCommit={sha} />,
    );
    expect(screen.getByText(/at 0d018a9 3h ago, not checked against the repository/)).toBeInTheDocument();
    expect(screen.queryByText(/naming no commit/)).not.toBeInTheDocument();
  });

  it("names a merge Forge saw as merged into the base branch", () => {
    state({});
    render(<AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease mergeMark="observed" />);
    expect(screen.getByText(/Merged into main 3h ago/)).toBeInTheDocument();
  });

  it("degrades to words, never a number, when nothing is scheduled to cut", () => {
    state({ nextCutAt: null });
    renderBanner();
    expect(screen.getByText(/No release is scheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/next release cut runs/)).not.toBeInTheDocument();
  });

  it("says Forge releases it on its own where the automatic release is on (ISS-1421 r13)", () => {
    state({ nextCutAt: null, automaticRelease: true });
    renderBanner();
    expect(
      screen.getByText(/Forge releases it on its own once its criteria pass and nothing holds it\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No release is scheduled/)).not.toBeInTheDocument();
  });

  it("counts down to a real cut when one is scheduled", () => {
    state({ nextCutAt: "2026-08-26T18:00:00.000Z" });
    renderBanner();
    expect(screen.getByText(/next release cut runs in 6h/)).toBeInTheDocument();
  });

  it("says a batch already owns the issue instead of offering to release it again", () => {
    state({}, "run-9");
    renderBanner();
    expect(screen.getByText(/it is in a release, whose run says whether a box has started it/)).toBeInTheDocument();
    expect(screen.queryByText(/shipping/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
  });

  it("makes Release now the page's primary action (ISS-1421)", () => {
    state({});
    renderBanner();
    expect(screen.getByRole("button", { name: "Release now" }).className).toContain("bg-accent");
  });

  it("withholds the action from a reader who cannot write", () => {
    state({});
    renderBanner(false);
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
  });
});

// ISS-1337: a release would hand this issue straight back, so the banner offers none.
describe("AwaitingReleaseBanner — an issue a release could not close", () => {
  const REFUSAL = {
    code: "OPEN_QUESTIONS",
    reason: "holds 1 open question",
    clears: 'Answer it in its "Decision waiting" card on the issue\'s page.',
    said: 'It holds 1 open question. Answer it in its "Decision waiting" card on the issue\'s page.',
    saidHere: "It holds 1 open question. Answer it in the Decision waiting card above.",
  };
  const NOT_MERGED = {
    code: "CLOSE_REQUIRES_SHIPPED",
    reason: "not marked merged",
    clears: "Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and name the commit that landed under Commit.",
    said: "It is not marked merged. Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and name the commit that landed under Commit.",
    saidHere: "It is not marked merged. Use Mark merged in the issue's properties. In the panel it opens, fill in Where it landed and name the commit that landed under Commit.",
  };

  it("offers no Release now and says what the close is refused for and what clears it", () => {
    state({}, null, [REFUSAL]);
    renderBanner();
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
    expect(screen.getByText("Not ready to release.")).toBeInTheDocument();
    expect(screen.getByText("It holds 1 open question. Answer it in the Decision waiting card above.")).toBeInTheDocument();
  });

  // ISS-1421 r5: two shortfalls were joined into "… fill in Where it landed. holds 1 open question.",
  // under a lead that read as if a release had failed.
  it("says two shortfalls as whole sentences, each opening with a capital, and never that a release failed", () => {
    state({}, null, [NOT_MERGED, REFUSAL]);
    const { container } = renderBanner();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/could not close/);
    for (const line of screen.getAllByRole("listitem")) {
      for (const sentence of (line.textContent ?? "").trim().split(/(?<=\.)\s+/)) {
        expect(sentence).toMatch(/^[A-Z"]/);
        expect(sentence).toMatch(/\.$/);
      }
    }
  });

  // ISS-1421 r5 repair 1: both shortfalls ran on in one paragraph, and the reader already on the
  // issue's page was sent to "the issue's page".
  it("lays each shortfall on a line of its own under the lead, each naming its door on this page", () => {
    state({}, null, [NOT_MERGED, REFUSAL]);
    const { container } = renderBanner();
    const lines = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toEqual([NOT_MERGED.saidHere, REFUSAL.saidHere]);
    expect(screen.getByRole("list", { name: "What is missing" })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/on the issue's page/);
  });

  // ISS-1381 r3: the comment a finish leaves says answer, then Release now on this page.
  it("offers Release now once the answer clears the refusal, and it releases this issue alone", () => {
    state({}, null, [REFUSAL]);
    const { rerender } = renderBanner();
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();

    state({}, null, []);
    rerender(<AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease />);
    fireEvent.click(screen.getByRole("button", { name: /release now/i }));

    expect(release).toHaveBeenCalledWith({ issueIds: ["iss-1"] });
  });

  // ISS-1300 r5 (judge-125, X2): the release door takes a project admin; anyone else is told who may.
  it("names who may release where the reader may not, and offers no button that would be refused", () => {
    state({}, null, []);
    render(<AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canRelease={false} askWhoReleases />);
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Only an admin of this project can release it, so ask one of them\./)).toBeInTheDocument();
  });

  it("still offers Release now on an issue whose close stands", () => {
    state({}, null, []);
    renderBanner();
    expect(screen.getByRole("button", { name: /release now/i })).toBeInTheDocument();
  });
});

// ISS-1381 r4: the last release failed this close on a fault nothing on the issue can clear, and
// nothing here can read when it is fixed, so Release now stays and says what it will meet.
describe("AwaitingReleaseBanner — an issue whose last release failed its close", () => {
  const FAILURE = {
    reason: 'the database refused the write (23514): violates check constraint "gj_closed_needs_ledger"',
    version: "0.6.0",
  };

  it("names the failure and says Release now fails the same way until whoever operates Forge fixes it", () => {
    state({}, null, [], FAILURE);
    renderBanner();
    expect(screen.getByText(/The last release \(version 0\.6\.0\) could not close this issue/)).toBeInTheDocument();
    expect(screen.getByText(/gj_closed_needs_ledger/)).toBeInTheDocument();
    expect(
      screen.getByText(/Release now fails the same way until whoever operates Forge fixes it/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /release now/i })).toBeInTheDocument();
    expect(screen.queryByText(/not shipped yet/)).not.toBeInTheDocument();
  });

  it("says nothing of a failure on an issue whose last release met none", () => {
    state({}, null, [], null);
    renderBanner();
    expect(screen.queryByText(/fails the same way/)).not.toBeInTheDocument();
  });
});

// ISS-1421 r37, judge-151 on criteria 366 and 367: the issue's own Release now was offered over an
// issue with no release note, and over a project no pick could release; both presses were refused.
describe("AwaitingReleaseBanner — Release now only where it is not refused", () => {
  it("offers no Release now on an issue with no release note, and says what makes it ready", () => {
    const releaseRefusals = [
      { code: "RELEASE_RECORD_MISSING", said: "It has no release note.", saidHere: "This issue has no release note. It needs one before it can be released." },
    ];
    state({}, null, [], null, releaseRefusals);
    renderBanner();
    expect(screen.getByText("Not ready to release.")).toBeInTheDocument();
    expect(screen.getByText("This issue has no release note. It needs one before it can be released.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
  });

  it("offers no Release now where the project refuses every pick, and says why", () => {
    state({ blockingAll: [{ code: "RELEASE_POOL_EMPTY", said: "This project has no runner registered. Pair a box to this project first.", runId: null }] });
    renderBanner();
    expect(screen.getByText("This project has no runner registered. Pair a box to this project first.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
  });
});

