// FB-583 (owner, 2026-11-08): "I don't understand their states" on /requirements and /feedback. Each
// row spoke several vocabularies at once. These draw both lists over a fake core, as forge-dev answered
// them that day, and hold what a row says now: one group in the shared words, the feedback chip core
// names, an ETA in one format, who acts next and never the reporter, and no steward sentence (the
// "steward's daily budget is spent" line repeated down the rows), which the item's own page shows.
//
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-screen.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirements-list.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirements-screen.tsx

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackScreen } from "@/features/feedback/components/feedback-screen";
import { RequirementsScreen } from "@/features/requirements/components/requirements-screen";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const P = "p1";
const NOW = Date.now();
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();
const BUDGET = "The steward's daily budget for this project is spent, so it did not act on feedback.filed here.";
const master = waitingOn("agent", { who: say("standing.who.projectMaster"), act: say("standing.act.takeNext", { issues: "“Title ISS-9”" }), rule: RULE });

const fb = (key: string, over: Record<string, unknown>) => ({
  id: key,
  key,
  title: `Title ${key}`,
  kind: "bug",
  severity: "medium",
  status: "triaged",
  phase: "planned",
  chip: "planned",
  attentionGroup: "queued",
  waitingOn: master,
  times: { actClass: "queue", since: iso(-60), dueAt: null, stuck: null, carriedBy: null, basis: "b" },
  target: { type: "screen", key: "Lists", title: null },
  route: null,
  reporter: { id: "u9", name: "catalog-api", agency: "agent" },
  origin: { project: { id: "p9", slug: "catalog", name: "Catalog API" }, issue: null, clientVersion: null, occurrences: 1 },
  dueAt: null,
  snoozed: null,
  redacted: false,
  redactedAt: null,
  createdAt: iso(-600),
  updatedAt: iso(-60),
  ...over,
});

/** Core's counts of a list holding no report, by whose turn it is. */
const NO_COUNTS = { needs_you: 0, running: 0, queued: 0, overdue: 0, waiting: 0, done: 0, dropped: 0 };
const FEEDBACK = [
  fb("FB-1", { phase: "planned", chip: "running", attentionGroup: "running" }),
  fb("FB-2", { phase: "planned", chip: "planned", attentionGroup: "queued" }),
  fb("FB-3", { phase: "declined", status: "declined", chip: "declined", attentionGroup: "dropped" }),
];

const stamp = { label: "forecast" as const, asOf: iso(0) };
const shipped = { ...stamp, landing: { ...stamp, kind: "landed", landedAt: iso(-3000) }, release: null, inHands: null, shipped: { version: "0.4.0-dev.589", at: iso(-2880) } };
const FORECASTS = { projectId: P, items: [{ key: "FB-1", triage: null, delivery: shipped, owes: "judgement" }] };

const noted = (kind: string, key: string, line: string) => ({
  subject: { kind, id: key, key },
  note: { subject: { kind, id: key, key }, lines: [line, "It acts again after midnight UTC."], cites: [], claims: {}, basis: "b", stale: false, factsVersion: null, writtenAt: iso(-5), writtenBy: { id: "s", name: "Steward", kind: "agent" }, runId: "r1" },
});

const coverage = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `BC-${i + 1}`, body: "b", verdict: "passing", verdicts: [], issues: [] }));
const REQUIREMENTS = [
  {
    id: "r78",
    key: "REQ-78",
    title: "ChatGPT and other MCP clients connect to Forge",
    shortName: null,
    area: null,
    status: "delivered",
    currentRevision: 2,
    latestRevision: null,
    standing: {
      state: "delivered",
      attentionGroup: "waiting",
      waitingOn: master,
      times: { actClass: "judge", since: iso(-60), dueAt: null, stuck: null, carriedBy: null, basis: "b" },
      facts: { criteria: 7, passing: 0, judged: 0, issuesRunning: 0, issuesTotal: 3 },
      coverage: coverage(7),
      owner: { id: "u1", name: "Lan", kind: "human" },
      touchedAt: iso(-60),
      stateSince: iso(-480),
      acceptedByDecision: null,
    },
    delivery: { criteriaCoverage: { criteria: 7, passing: 0 } },
  },
];

function core() {
  return fakeCore((c) => {
    if (c.path.startsWith(`/projects/${P}/forecast/feedback`)) return { body: FORECASTS };
    if (c.path.startsWith(`/projects/${P}/forecast`)) return { body: { projectId: P, items: [] } };
    if (c.path.startsWith(`/projects/${P}/standings`)) return { body: { standings: [noted("feedback", "FB-2", BUDGET), noted("requirement", "REQ-78", BUDGET.replace("feedback.filed", "requirement.agreed"))] } };
    if (c.path.startsWith(`/projects/${P}/feedback`)) return { body: { feedback: FEEDBACK, counts: { ...NO_COUNTS, running: 1, queued: 1, dropped: 1 }, total: 3, open: 2, sensitive: false } };
    if (c.path.startsWith(`/projects/${P}/requirements`)) return { body: { requirements: REQUIREMENTS, returned: 1 } };
    if (c.path.includes("/suggestions")) return { body: { suggestions: [], open: 0 } };
    return { body: {} };
  });
}

const row = async (title: string) => {
  const rows = await screen.findAllByTestId("list-row");
  const r = rows.find((x) => x.textContent?.includes(title));
  if (!r) throw new Error(`no row reads ${title}`);
  return r;
};

describe("the Feedback list in one vocabulary", () => {
  it("groups in the shared words, Dropped apart from Done", async () => {
    core();
    renderWithQuery(<FeedbackScreen projectId={P} slug="hop" />);
    await row("Title FB-1");
    const list = screen.getByTestId("grouped-list");
    for (const g of ["Running", "Queued", "Dropped"]) expect(within(list).getAllByText(g).length).toBeGreaterThan(0);
    for (const old of ["Moving", "Stuck", "Someone else’s turn"]) expect(list).not.toHaveTextContent(old);
  });

  it("draws core's chip, not the phase: a planned item whose carrier runs says Running", async () => {
    core();
    renderWithQuery(<FeedbackScreen projectId={P} slug="hop" />);
    expect(within(await row("Title FB-1")).getByTestId("feedback-row-state")).toHaveTextContent("Running");
    expect(within(await row("Title FB-2")).getByTestId("feedback-row-state")).toHaveTextContent("Planned");
  });

  it("never draws a steward sentence on a row, the budget line included", async () => {
    core();
    renderWithQuery(<FeedbackScreen projectId={P} slug="hop" />);
    await row("Title FB-2");
    // the standings read is answered before the rows are judged
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.getByTestId("grouped-list")).not.toHaveTextContent("daily budget");
    expect(screen.queryByTestId("row-note")).toBeNull();
  });

  it("names who acts next and never the reporter or the project it came from", async () => {
    core();
    renderWithQuery(<FeedbackScreen projectId={P} slug="hop" />);
    const r = await row("Title FB-2");
    expect(within(r).getByTestId("waiting-on")).toHaveTextContent("master");
    expect(r).not.toHaveTextContent("catalog-api");
    expect(r).not.toHaveTextContent("Catalog API");
    expect(screen.getByTestId("grouped-list")).not.toHaveTextContent("Owner");
  });

  it("reads the ETA in one format: shipped work says Shipped and its version alone", async () => {
    core();
    renderWithQuery(<FeedbackScreen projectId={P} slug="hop" />);
    const r = await row("Title FB-1");
    const cell = await within(r).findByText("Shipped 0.4.0-dev.589");
    expect(cell.closest("[data-testid=eta-cell]")?.textContent).toBe("Shipped 0.4.0-dev.589");
  });
});

describe("the Requirements list in one vocabulary", () => {
  it("reads Passing as the record does, and draws no steward sentence and no stage word", async () => {
    core();
    renderWithQuery(<RequirementsScreen projectId={P} slug="hop" />);
    const r = await row("ChatGPT and other MCP clients");
    await new Promise((done) => setTimeout(done, 50));
    expect(within(r).getByTestId("req-passing")).toHaveTextContent("7/7");
    expect(r).not.toHaveTextContent("daily budget");
    expect(r).not.toHaveTextContent("Your check");
    expect(screen.getByText("Waiting on others")).toBeInTheDocument();
  });
});

// ui-copy-rule (judged at 0.4.0-dev.646): a list with nothing in it still opens on its overview band, reading zero
describe("an empty list opens on its band", () => {
  const none = () =>
    fakeCore((c) => {
      if (c.path.startsWith(`/projects/${P}/feedback`)) return { body: { feedback: [], counts: NO_COUNTS, total: 0, open: 0, sensitive: false } };
      if (c.path.startsWith(`/projects/${P}/requirements`)) return { body: { requirements: [], returned: 0 } };
      if (c.path.includes("/suggestions")) return { body: { suggestions: [], open: 0 } };
      return { body: {} };
    });

  it.each([
    ["Feedback", "feedback-band", () => <FeedbackScreen projectId={P} slug="hop" />],
    ["Requirements", "requirements-band", () => <RequirementsScreen projectId={P} slug="hop" />],
  ])("draws %s's band over no rows, its first figure zero", async (_, band, draw) => {
    none();
    renderWithQuery(draw());
    const drawn = await screen.findByTestId(band);
    expect(within(drawn).getAllByTestId("band-figure-value")[0]?.textContent).toBe("0");
  });
});
