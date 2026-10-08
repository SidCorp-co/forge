// @vitest-environment jsdom
//
// ISS-1156 — every reader of the health rollup says pending while it is on its way and failed when
// it did not come in. A figure drawn as 0, an "idle" dot, "0 live runs" or no banner would be the
// face of a project with no work, which is what a failed read is not.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryRead } from "@/design/patterns/badge-read";
import type { ProjectConsoleItem, WorkspaceTotals } from "../types";
import { AttentionBanner } from "./attention-banner";
import { LiveCount } from "./live-count";
import { ProjectCard } from "./project-card";
import { ProjectList } from "./project-list";
import { StatsBand } from "./stats-band";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

afterEach(cleanup);

const unread = (read: QueryRead): ProjectConsoleItem => ({
  id: "p1", slug: "sable", name: "Sable", orgId: "o1", orgName: "Org", orgIsPersonal: true, role: "admin",
  createdAt: "2026-10-01T00:00:00Z", description: null, repoPath: null, healthRead: read, health: null,
  liveRuns: null, openIssues: null, runnerCount: null, spend24hUsd: null, memberCount: null, members: [],
  lastActivityAt: null, pinned: false,
});
const read: ProjectConsoleItem = {
  ...unread("read"), health: "healthy", liveRuns: 2, openIssues: 29, runnerCount: 1, spend24hUsd: 1.5, memberCount: 3, members: ["AB"],
  lastActivityAt: "2026-10-02T00:00:00Z",
};
const totals = (healthRead: QueryRead): WorkspaceTotals =>
  healthRead === "read"
    ? { projects: 2, healthRead, liveRuns: 2, openIssues: 29, runners: 1, spend24hUsd: 1.5 }
    : { projects: 2, healthRead, liveRuns: null, openIssues: null, runners: null, spend24hUsd: null };

const FAILED = /could not be read/;
const PENDING = /^reading /;
const NO_STATEMENT = /^0 live runs$|^0 live$|\$0\.00|^0$/;

function marks(re: RegExp) {
  return screen.queryAllByLabelText(re);
}

describe.each([
  ["failed", FAILED, "!"],
  ["pending", PENDING, "…"],
] as const)("a health read that is %s", (state, name, mark) => {
  it("is named in the workspace stats band for each of its four figures, with the project count still stated", () => {
    render(<StatsBand totals={totals(state)} />);
    expect(screen.getByText("2 projects")).toBeTruthy();
    expect(marks(name)).toHaveLength(4);
    for (const m of marks(name)) expect(m.textContent).toBe(mark);
    expect(marks(name).map((m) => m.getAttribute("aria-label")).join("|")).toMatch(/open work/);
    expect(document.body.textContent).not.toMatch(/\b0 open work|\b0 runners|\$0\.00/);
  });

  it("is named on a project card where the figures were, and the health dot claims no health", () => {
    render(<ProjectCard project={unread(state)} now={0} onTogglePin={() => {}} />);
    expect(marks(name).length).toBeGreaterThanOrEqual(5);
    expect(marks(name).map((m) => m.getAttribute("aria-label")).join("|")).toMatch(/health/);
    expect(document.body.textContent).not.toMatch(/0 live runs|\$0\.00/);
  });

  it("is named in the projects list, row by row", () => {
    render(<ProjectList items={[unread(state)]} now={0} onTogglePin={() => {}} />);
    expect(marks(name).length).toBeGreaterThanOrEqual(5);
    expect(marks(name).map((m) => m.getAttribute("aria-label")).join("|")).toMatch(/health/);
    expect(document.body.textContent).not.toMatch(/\$0\.00/);
  });

  it("is named by the attention banner instead of hiding it as a count of none", () => {
    render(<AttentionBanner count={0} read={state} attentionOnly={false} onToggle={() => {}} onRetry={() => {}} />);
    expect(screen.getByRole("status").textContent).toMatch(state === "failed" ? /could not be read/ : /reading/i);
  });

  it("is named by the live-run count, never as 0 live runs", () => {
    render(<LiveCount n={null} read={state} />);
    expect(marks(name)).toHaveLength(1);
    expect(screen.queryByText(NO_STATEMENT)).toBeNull();
  });
});

describe("a health read that came in", () => {
  it("states every figure as before, a read zero included", () => {
    render(<StatsBand totals={totals("read")} />);
    expect(screen.getByText(/29 open work/)).toBeTruthy();
    expect(marks(FAILED)).toHaveLength(0);
    cleanup();
    render(<ProjectCard project={read} now={Date.parse("2026-10-02T01:00:00Z")} onTogglePin={() => {}} />);
    expect(screen.getByText("2 live runs")).toBeTruthy();
    expect(screen.getByText("29")).toBeTruthy();
    expect(marks(FAILED)).toHaveLength(0);
    cleanup();
    render(<LiveCount n={0} read="read" />);
    expect(screen.getByText("0 live runs")).toBeTruthy();
  });

  it("shows the banner for projects that need attention and none for a read zero", () => {
    render(<AttentionBanner count={2} read="read" attentionOnly={false} onToggle={() => {}} onRetry={() => {}} />);
    expect(screen.getByText(/need attention/)).toBeTruthy();
    cleanup();
    const { container } = render(<AttentionBanner count={0} read="read" attentionOnly={false} onToggle={() => {}} onRetry={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
