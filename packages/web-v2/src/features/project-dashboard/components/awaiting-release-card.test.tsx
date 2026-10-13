// @vitest-environment jsdom
//
// ISS-1156 — the card lists runs parked at the release gate, and the donut beside it counts issues
// in the Awaiting release state. The two are different things, so the card says which it is and
// never reads "Nothing waiting" while the donut reads five.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import type { ReadState } from "../shape";
import { AwaitingReleaseCard } from "./awaiting-release-card";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

const run = (n: number): PipelineRunListItem =>
  ({
    id: `r${n}`,
    projectId: "p1",
    issueId: `i${n}`,
    issueRef: `ISS-${n}`,
    issueTitle: "An issue",
    kind: "issue",
    status: "running",
    currentStep: "tested",
    startedAt: "2026-09-05T14:16:00Z",
    finishedAt: null,
  }) as unknown as PipelineRunListItem;

function mount(runs: PipelineRunListItem[], awaitingReleaseIssues: number, read?: ReadState) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <AwaitingReleaseCard
          runs={runs}
          slug="forge-dev"
          projectId="p1"
          awaitingReleaseIssues={awaitingReleaseIssues}
          read={read}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("the Awaiting release card", () => {
  it("says nothing is waiting only when no issue is Awaiting release either", () => {
    mount([], 0);
    expect(screen.getByRole("region", { name: "Awaiting release" })).toHaveTextContent(
      "nothing waiting on a release decision",
    );
  });

  it("names the runs read while it has not arrived, and says neither nothing waiting nor a count of runs at the gate", () => {
    mount([], 0, { read: "failed", reason: "Gateway Timeout" });
    const section = screen.getByRole("region", { name: "Awaiting release" });
    expect(section).toHaveTextContent("The project's runs could not be read: Gateway Timeout");
    expect(section).not.toHaveTextContent(/nothing waiting|no release run/i);
  });

  it("does not say nothing is waiting beside issues that are Awaiting release", () => {
    mount([], 5);
    expect(screen.queryByText(/nothing waiting/i)).toBeNull();
    expect(screen.getByText("5 issues")).toBeInTheDocument();
    expect(screen.getByText("no release run at the gate")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See them in Issues" })).toHaveAttribute(
      "href",
      "/projects/forge-dev/issues?filter=awaiting_release",
    );
  });

  it("names what its list holds against the state's count, so two figures read as two things", () => {
    mount([run(1), run(2)], 5);
    expect(
      screen.getByText(/5 issues are Awaiting release; this list holds the 2 with a release run parked at the gate/),
    ).toBeInTheDocument();
  });
});
