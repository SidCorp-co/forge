// FB-102: dev's ISS-294 read "Run: Completed" in Properties while its Runs tab counted 0 and said
// "Steps: None yet" — the tab counted recorded steps, and a delegated run records none — and the
// release that shipped it (dev.72) was only in comment prose. The rail now names that release as a
// link, and the Runs tab counts and lists the issue's runs whether or not they recorded steps.

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssueAgentSession, IssueDetail } from "../types";
import { RunsTab, runsTabCount } from "./detail/issue-tabs";
import { PropertiesRail } from "./properties-rail";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => vi.unstubAllGlobals());

const issue = (over: Partial<IssueDetail>) =>
  ({ id: "i-294", projectId: "p1", displayId: "ISS-294", title: "t", status: "closed", priority: "medium", labels: [], ...over }) as IssueDetail;

function rail(detail: IssueDetail) {
  fakeCore(() => ({ body: {} }));
  renderWithQuery(
    <PropertiesRail issue={detail} slug="forge" cost={undefined} deps={undefined} pending={false} onPatch={() => {}} onTransition={() => {}} moves={[]} />,
  );
}

const RUN: IssueAgentSession = {
  id: "s1",
  status: "completed",
  metadata: null,
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T11:00:00.000Z",
  title: "nv3 lane",
  deviceName: "box-1",
  pipelineRunId: "run-7",
  heartbeat: "unknown",
  continuity: "unknown",
  freshReason: null,
};
const settled = { isLoading: false, isError: false, error: null } as never;

describe("the release that shipped an issue", () => {
  it("names it as a link to the release, and nothing while none has shipped it", () => {
    rail(issue({ shippedIn: { version: "0.4.0-dev.72", at: "2026-10-05T12:00:00.000Z" } }));
    const link = within(screen.getByTestId("rail-shipped-in")).getByRole("link", { name: "0.4.0-dev.72" });
    expect(link.getAttribute("href")).toBe("/projects/forge/releases/0.4.0-dev.72");
  });

  it("shows no row on an issue no release shipped", () => {
    rail(issue({ shippedIn: null, status: "awaiting_release" }));
    expect(screen.queryByTestId("rail-shipped-in")).toBeNull();
  });
});

describe("the Runs tab", () => {
  it("counts the issue's runs, not the steps they recorded", () => {
    expect(runsTabCount([RUN], [])).toBe(1);
    expect(runsTabCount([], [])).toBe(0);
  });

  it("lists a run that recorded no steps, linked to the run", () => {
    fakeCore(() => ({ body: { issueId: "i1", totalMs: 0, kinds: [], checks: [] } }));
    renderWithQuery(<RunsTab issueId="i1" slug="forge" sessions={[RUN]} standingQ={settled} stepOutcomes={[]} expandedStep={null} onToggleStep={() => {}} />);
    const row = screen.getByTestId("issue-run");
    expect(row).toHaveTextContent("nv3 lane");
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/projects/forge/agents/runs/run-7");
  });

  it("shows the time the issue's runs spent on checks (REQ-36 BC-14)", async () => {
    const core = fakeCore(() => ({ body: { issueId: "i1", totalMs: 0, kinds: [], checks: [] } }));
    renderWithQuery(<RunsTab issueId="i1" slug="forge" sessions={[]} standingQ={settled} stepOutcomes={[]} expandedStep={null} onToggleStep={() => {}} />);
    expect(await screen.findByTestId("issue-checks")).toHaveTextContent("Checks");
    expect(core.map((c) => c.path)).toContain("/issues/i1/checks");
  });
});
