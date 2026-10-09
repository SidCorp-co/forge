// The time an issue's runs spent on checks, shown on its Runs tab (REQ-36 BC-14; ISS-474).

import type { IssueChecksView } from "@forge/contracts/check-runs";
import { checkTimeByKind } from "@forge/contracts/check-runs";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { IssueAgentSession } from "../../types";
import { CheckTimes } from "./check-times";

afterEach(() => vi.unstubAllGlobals());

const SESSION = "5e55a0b1-0000-4000-8000-000000000001";
const RUN: IssueAgentSession = {
  id: SESSION,
  status: "completed",
  metadata: null,
  createdAt: "2026-10-09T05:00:00.000Z",
  updatedAt: "2026-10-09T06:00:00.000Z",
  title: "ISS-474 build",
  deviceName: "box-1",
  pipelineRunId: "run-9",
  heartbeat: "unknown",
  continuity: "unknown",
  freshReason: null,
};

const check = (over: Partial<IssueChecksView["checks"][number]>): IssueChecksView["checks"][number] => ({
  id: "c1",
  kind: "tests",
  name: "direct-tests",
  scope: "@forge/core",
  command: "vitest run",
  files: [],
  result: "pass",
  durationMs: 4000,
  startedAt: "2026-10-09T06:00:00.000Z",
  head: "a".repeat(40),
  note: null,
  runSessionId: SESSION,
  via: "report",
  recordedAt: "2026-10-09T06:01:00.000Z",
  ...over,
});

const viewOf = (checks: IssueChecksView["checks"]): IssueChecksView => ({
  issueId: "i1",
  totalMs: checks.reduce((s, c) => s + c.durationMs, 0),
  kinds: checkTimeByKind(checks),
  checks,
});

const show = (view: IssueChecksView) => {
  const core = fakeCore((call) => (call.path === "/issues/i1/checks" ? { body: view } : undefined));
  renderWithQuery(<CheckTimes issueId="i1" slug="forge" sessions={[RUN]} />);
  return core;
};

describe("the checks an issue's runs made", () => {
  it("shows the time spent on each kind, its count and its slowest check", async () => {
    show(
      viewOf([
        check({ id: "c1", durationMs: 4000 }),
        check({ id: "c2", name: "integration-tests", durationMs: 95000 }),
        check({ id: "c3", kind: "typecheck", name: "typecheck", scope: "typescript", durationMs: 12000 }),
      ]),
    );
    const row = (await screen.findAllByTestId("check-kind"))[0] as HTMLElement;
    expect(row).toHaveTextContent("Tests");
    expect(row).toHaveTextContent("1m 39s");
    expect(row).toHaveTextContent("2 checks");
    expect(row).toHaveTextContent("Slowest: integration-tests (@forge/core), 1m 35s");
    expect(screen.getByText("1m 51s in all")).toBeInTheDocument();
  });

  it("lists every kind, a kind no run recorded saying so", async () => {
    show(viewOf([check({})]));
    await screen.findAllByTestId("check-kind");
    const kinds = screen.getAllByTestId("check-kind").map((r) => r.getAttribute("data-kind"));
    expect(kinds).toEqual(["tests", "typecheck", "probes", "review", "conformance", "base"]);
    const probes = screen.getAllByTestId("check-kind")[2] as HTMLElement;
    expect(probes).toHaveTextContent("Probes");
    expect(probes).toHaveTextContent("None recorded");
  });

  it("shows each check with its result, duration and the run that made it", async () => {
    show(viewOf([check({ result: "fail", durationMs: 7000 }), check({ id: "c2", runSessionId: null })]));
    const rows = await screen.findAllByTestId("check-run");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("direct-tests (@forge/core)");
    expect(rows[0]).toHaveTextContent("Failed");
    expect(rows[0]).toHaveTextContent("7s");
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "ISS-474 build" }).getAttribute("href")).toBe(
      "/projects/forge/agents/runs/run-9",
    );
    expect(rows[1]).toHaveTextContent("Not in a run");
  });

  it("says no check is recorded yet, still listing the kinds", async () => {
    show(viewOf([]));
    expect(await screen.findByText("Checks appear here once a run records the checks it timed.")).toBeInTheDocument();
    expect(screen.getAllByTestId("check-kind")).toHaveLength(6);
  });
});
