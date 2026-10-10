// The release page's own screen: it opens on the user view, a switch shows the developer view with
// the operator's panes under it, and the reader is read from the page endpoint in the view chosen.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ReleasePage } from "./release-page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/forge/releases/0.4.0",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const DETAIL = {
  key: "0.4.0",
  version: "0.4.0",
  state: "shipped",
  runId: "run-1",
  approval: null,
  verified: { level: "criteria", proven: 2, total: 3, check: null, provider: null },
  issues: [],
  gates: [],
  cuts: [],
  attempts: [],
  approvals: [],
  criteria: { total: 0 },
  issueCriteria: [],
  requirementsCompleted: [],
  feedbackAnswered: [],
  feedbackToldCounts: { told: 0, not_told: 0, before_notices: 0, on_ship: 0 },
  notes: { sections: [], designs: [], withoutNotes: [], reworked: [], language: "en", attention: [] },
  changes: TECHNICAL.changes,
  production: null,
  continuedAs: null,
  can: { cut: false, decide: false, split: false },
  attentionGroup: "done",
  waitingOn: { kind: "none", who: "", act: "", rule: "r", ref: null, dueAt: null },
};

function serve() {
  return fakeCore((c) => {
    if (c.path === "/projects/p1/releases/0.4.0") return { body: { release: DETAIL } };
    if (c.path === "/projects/p1/releases") return { body: { releases: [] } };
    if (c.path === "/projects/p1/releases/0.4.0/page?view=user") return { body: releasePage() };
    if (c.path === "/projects/p1/releases/0.4.0/page?view=developer") return { body: releasePage({ view: "developer", technical: TECHNICAL }) };
    return { body: {} };
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/projects/forge/releases/0.4.0");
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("the release page screen", () => {
  it("opens on the user view: the reader without technical notes, and none of the operator's tabs", async () => {
    const calls = serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    expect(await screen.findByTestId("release-reader")).toHaveAttribute("data-view", "user");
    expect(calls.some((c) => c.path === "/projects/p1/releases/0.4.0/page?view=user")).toBe(true);
    expect(screen.queryByTestId("page-technical")).toBeNull();
    expect(screen.queryByTestId("release-tabs")).toBeNull();
  });

  it("shows the developer view from ?view=developer: technical notes above the operator's tabs", async () => {
    window.history.replaceState(null, "", "/projects/forge/releases/0.4.0?view=developer");
    const calls = serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    expect(await screen.findByTestId("page-technical")).toBeTruthy();
    expect(await screen.findByTestId("release-tabs")).toBeTruthy();
    expect(calls.some((c) => c.path === "/projects/p1/releases/0.4.0/page?view=developer")).toBe(true);
  });

  it("switches to the developer view from the switch and back", async () => {
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("release-reader");
    fireEvent.click(screen.getByRole("button", { name: "Developer" }));
    await waitFor(() => expect(window.location.search).toContain("view=developer"));
    expect(await screen.findByTestId("page-technical")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "User" }));
    await waitFor(() => expect(screen.queryByTestId("page-technical")).toBeNull());
  });
});

// QA 0.4.0-dev.220: the header and the Proof panel said "8 of 22 criteria proven" while the list
// showed 5 proven + 15 not yet proven. The seeded set of release-page-range-e2e.test.ts, as core
// serves it: a pass, a short, a pass on an earlier build only, a fail, a proven criterion tracing no
// code, and one of an issue tracing no requirement. Core counts the record and the page by one rule;
// the screen draws the header, the panel and the list from those numbers and rows.
describe("the header, the Proof panel and the list say one count (BC-5)", () => {
  const verified = { level: "some_criteria" as const, proven: 4, total: 6, check: null, provider: null };
  const page = releasePage({
    header: { ...releasePage().header, verified },
    requirements: [
      {
        key: "REQ-1",
        title: "Visit reminders",
        completes: false,
        proven: [
          { code: "BC-1", statement: "A nurse sees the reminder", short: false, issueKey: "ISS-1", n: 1 },
          { code: "BC-2", statement: "A nurse sees it on a phone", short: true, issueKey: "ISS-1", n: 2 },
          { code: null, statement: "(REQ-1 BC-2) the reminder names the patient", short: false, issueKey: "ISS-2", n: 1 },
        ],
        unproven: 2,
        business: {
          total: 3,
          proven: [
            { code: "BC-1", statement: "A nurse is reminded of the visit" },
            { code: "BC-2", statement: "The reminder reaches a phone" },
          ],
        },
      },
    ],
    untraced: {
      proven: [{ code: null, statement: "the list loads in a second", short: false, issueKey: "ISS-3", n: 1 }],
      unproven: 0,
    },
  });

  it("reads the same proven and total in the header, the panel and the rows of the list", async () => {
    fakeCore((c) => {
      if (c.path === "/projects/p1/releases/0.4.0")
        return { body: { release: { ...DETAIL, verified, criteria: { proven: 4, failing: 1, open: 1, total: 6 } } } };
      if (c.path === "/projects/p1/releases") return { body: { releases: [] } };
      if (c.path === "/projects/p1/releases/0.4.0/page?view=user") return { body: page };
      return { body: {} };
    });
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    const header = await screen.findByTestId("page-header-verified");
    expect(header).toHaveTextContent("Partly verified: 4 of 6 criteria proven");
    // said once: the rail beside the reader carries no Proof panel (REQ-43 BC-5)
    expect(screen.queryByTestId("facts-proof")).toBeNull();
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
    // every proven issue criterion is a row; the rest are the known issues
    const rows = screen.getAllByTestId("page-proven-row");
    expect(rows).toHaveLength(4);
    expect(rows.length + screen.getAllByTestId("page-known-issue").length).toBe(6);
    // a user's view counts in the pills, marks each row, and names no issue, number or code (REQ-43 BC-7, BC-10)
    expect(screen.queryByTestId("page-requirement-count")).toBeNull();
    expect(screen.getAllByTestId("page-proven-short")).toHaveLength(1);
    expect(rows[2]).toHaveTextContent(/^✓the reminder names the patient$/);
    expect(within(screen.getByTestId("page-untraced")).getByTestId("page-proven-row")).toHaveTextContent(/^✓the list loads in a second$/);
  });
});

