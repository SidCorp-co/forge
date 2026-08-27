// @vitest-environment jsdom
//
// Per-file jsdom opt-in — see the docblock on
// project-dashboard/awaiting-release-card.test.tsx for why the shared config
// stays `environment: 'node'`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseRoster } from "../api";
import { AwaitingReleaseBanner } from "./awaiting-release-banner";

expect.extend(matchers);

const roster = vi.fn();
vi.mock("../hooks", () => ({
  useReleaseRoster: () => roster(),
  useBatchRelease: () => ({ mutate: vi.fn(), isPending: false }),
}));

const NOW = new Date("2026-08-26T12:00:00.000Z");

function state(over: Partial<ReleaseRoster>, claimed: string | null = null) {
  roster.mockReturnValue({
    data: {
      gateStatus: "tested",
      nextCutAt: null,
      channel: "coolify",
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
        },
      ],
      ...over,
    },
  });
}

const renderBanner = (canWrite = true) =>
  render(<AwaitingReleaseBanner projectId="proj-1" issueId="iss-1" canWrite={canWrite} />);

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

  it("degrades to words, never a number, when nothing is scheduled to cut", () => {
    state({ nextCutAt: null });
    renderBanner();
    expect(screen.getByText(/No release is scheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/next release cut runs/)).not.toBeInTheDocument();
  });

  it("counts down to a real cut when one is scheduled", () => {
    state({ nextCutAt: "2026-08-26T18:00:00.000Z" });
    renderBanner();
    expect(screen.getByText(/next release cut runs in 6h/)).toBeInTheDocument();
  });

  it("says a batch already owns the issue instead of offering to release it again", () => {
    state({}, "run-9");
    renderBanner();
    expect(screen.getByText(/a release is shipping it now/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
  });

  it("withholds the action from a reader who cannot write", () => {
    state({});
    renderBanner(false);
    expect(screen.queryByRole("button", { name: /release now/i })).not.toBeInTheDocument();
  });
});
