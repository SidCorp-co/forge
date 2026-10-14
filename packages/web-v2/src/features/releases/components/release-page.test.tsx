// The release page's own screen: it opens on the user view, a switch shows the developer view with
// the operator's panes under it, and the reader is read from the page endpoint in the view chosen.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railBeside } from "@/test/rail-beside";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ReleasePage } from "./release-page";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
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
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("", { status: 404 }))));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  it("lists the page's contents at the top of the rail, above its facts, and keeps the reader's menu for where the rail falls under the page", async () => {
    railBeside();
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    const list = await screen.findByTestId("release-rail-contents");
    const rail = screen.getByTestId("facts-rail");
    expect(rail).toContainElement(list);
    // first in the rail, before the release's own facts
    expect(list.compareDocumentPosition(within(rail).getByTestId("release-facts")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "#release-highlights",
      "#release-new",
      "#release-fixed",
      "#release-requirements",
      "#release-open",
      "#release-other",
      "#release-admin",
    ]);
    // the rail's list shows from 1024px, the reader's one-control menu only below it
    expect(list.parentElement?.className).toMatch(/(^|\s)max-lg:hidden(\s|$)/);
    expect(screen.getByTestId("page-contents").className).toMatch(/(^|\s)lg:hidden(\s|$)/);
  });

  it("switches to the Technical view from the switch and back", async () => {
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("release-reader");
    fireEvent.click(screen.getByRole("button", { name: "Technical" }));
    await waitFor(() => expect(window.location.search).toContain("view=developer"));
    expect(await screen.findByTestId("page-technical")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
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
    const header = await screen.findByTestId("page-header");
    expect(header).toHaveTextContent("Partly verified: 4 of 6 criteria proven");
    // said once: the rail beside the reader carries no Proof panel (REQ-43 BC-5)
    expect(screen.queryByTestId("facts-proof")).toBeNull();
    expect(screen.queryByTestId("release-verified-by")).toBeNull();
    // the requirement's 3 proven rows, the untraced one, and the 2 still open sum to the header's 6
    expect(screen.getByTestId("page-requirement")).toHaveTextContent("Checks passed: 3");
    const open = screen.getAllByTestId("page-known-issue").map((r) => Number(within(r).getByText(/^\d+ open$/).textContent?.split(" ")[0]));
    expect(3 + (page.untraced?.proven.length ?? 0) + open.reduce((a, b) => a + b, 0)).toBe(6);
    // a row opened in a user's view marks each criterion and names no issue number or code (REQ-43 BC-7, BC-10)
    const iss2 = screen.getAllByTestId("page-change").find((r) => r.getAttribute("data-row-key") === "ISS-2");
    if (!iss2) throw new Error("no ISS-2 row");
    fireEvent.click(within(iss2).getAllByRole("button")[0]);
    const lines = [...within(iss2).getByTestId("page-row-detail").querySelectorAll("li")].map((l) => l.textContent);
    expect(lines).toEqual(["✓the reminder names the patient"]);
    const iss1 = screen.getAllByTestId("page-change").find((r) => r.getAttribute("data-row-key") === "ISS-1");
    if (!iss1) throw new Error("no ISS-1 row");
    fireEvent.click(within(iss1).getAllByRole("button")[0]);
    expect([...within(iss1).getByTestId("page-row-detail").querySelectorAll("li")].map((l) => l.textContent)).toEqual(["✓A nurse sees the reminder", "≈A nurse sees it on a phone"]);
  });
});

