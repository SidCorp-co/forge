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

  it("shows the developer view from ?view=developer: technical notes, then the release's record, under one navigation", async () => {
    window.history.replaceState(null, "", "/projects/forge/releases/0.4.0?view=developer");
    const calls = serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    expect(await screen.findByTestId("page-technical")).toBeTruthy();
    expect(await screen.findByTestId("release-record")).toBeTruthy();
    // no second tab strip under the page, and none of what it repeated (PR #1055 review)
    expect(screen.queryByTestId("release-tabs")).toBeNull();
    for (const word of ["Release train", "Requirements it completes", "criteria passing"]) expect(document.body).not.toHaveTextContent(word);
    expect(calls.some((c) => c.path === "/projects/p1/releases/0.4.0/page?view=developer")).toBe(true);
  });

  it("reads the rail as where it stands, its requirements counted, then the page's contents, keeping the reader's menu for where the rail falls under the page", async () => {
    railBeside();
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    const list = await screen.findByTestId("release-rail-contents");
    const rail = screen.getByTestId("facts-rail");
    expect(rail).toContainElement(list);
    const order = [...within(rail).getByTestId("release-rail").querySelectorAll("[data-testid='release-standing'], [data-testid='rail-requirements'], [data-testid='release-rail-contents']")].map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["release-standing", "rail-requirements", "release-rail-contents"]);
    // a requirement is counted in the checks this release meets, never listed criterion by criterion (BC-5)
    expect(within(rail).getByTestId("rail-requirement")).toHaveTextContent("REQ-40 · Release page2 of its 13 criteria proven");
    expect(rail).not.toHaveTextContent("Each release has a page.");
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["#release-highlights", "#release-admin", "#release-new", "#release-fixed"]);
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
describe("the rail and the Technical view's list say one count (BC-5)", () => {
  const verified = { level: "some_criteria" as const, proven: 4, total: 6, check: null, provider: null };
  const page = releasePage({
    header: { ...releasePage().header, verified },
    requirements: [
      {
        key: "REQ-1",
        title: "Visit reminders",
        completes: false,
        proven: [
          { code: "BC-1", statement: "A nurse sees the reminder", short: false, issueKey: "ISS-1", n: 1, countedUnderCutover: false },
          { code: "BC-2", statement: "A nurse sees it on a phone", short: true, issueKey: "ISS-1", n: 2, countedUnderCutover: false },
          { code: null, statement: "(REQ-1 BC-2) the reminder names the patient", short: false, issueKey: "ISS-2", n: 1, countedUnderCutover: false },
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
      proven: [{ code: null, statement: "the list loads in a second", short: false, issueKey: "ISS-3", n: 1, countedUnderCutover: false }],
      unproven: 0,
    },
  });

  it("reads the same proven and total in the rail and the rows of the Technical view's list", async () => {
    window.history.replaceState(null, "", "/projects/forge/releases/0.4.0?view=developer");
    fakeCore((c) => {
      if (c.path === "/projects/p1/releases/0.4.0")
        return { body: { release: { ...DETAIL, verified, criteria: { proven: 4, failing: 1, open: 1, unproven: 0, total: 6 } } } };
      if (c.path === "/projects/p1/releases") return { body: { releases: [] } };
      if (c.path === "/projects/p1/releases/0.4.0/page?view=developer") return { body: { ...page, view: "developer", technical: TECHNICAL } };
      return { body: {} };
    });
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("page-requirements");
    expect(screen.getByTestId("standing-verified")).toHaveTextContent("4 of 6 checks met");
    // said once: the rail carries no Proof panel (REQ-43 BC-5)
    expect(screen.queryByTestId("facts-proof")).toBeNull();
    // the requirement's 3 proven rows, the untraced one, and the 2 still open sum to the header's 6
    expect(screen.getByTestId("page-requirement")).toHaveTextContent("3 checks trace to REQ-1");
    const open = screen.getAllByTestId("page-known-issue").map((r) => Number(within(r).getByText(/^\d+ open$/).textContent?.split(" ")[0]));
    expect(3 + (page.untraced?.proven.length ?? 0) + open.reduce((a, b) => a + b, 0)).toBe(6);
    // a row opened on the Technical view marks each criterion by its number on its issue (REQ-43 BC-7, BC-10)
    const iss2 = screen.getAllByTestId("page-change").find((r) => r.getAttribute("data-row-key") === "ISS-2");
    if (!iss2) throw new Error("no ISS-2 row");
    fireEvent.click(within(iss2).getAllByRole("button")[0]);
    const lines = [...within(iss2).getByTestId("page-row-detail").querySelectorAll("li")].map((l) => l.textContent);
    expect(lines).toEqual(["✓#1(REQ-1 BC-2) the reminder names the patient"]);
    const iss1 = screen.getAllByTestId("page-change").find((r) => r.getAttribute("data-row-key") === "ISS-1");
    if (!iss1) throw new Error("no ISS-1 row");
    fireEvent.click(within(iss1).getAllByRole("button")[0]);
    const proof = within(iss1).getByTestId("page-row-detail");
    // a short is drawn as the Criteria tab draws it: the hollow ✓ in the warn tone, named Short, never ≈ and never a pass
    const rule = "a short on the release proof list is the Criteria tab's hollow warn ✓, never ≈ or a pass's ✓";
    const short = within(proof).queryByTestId("proof-short-mark");
    if (!short) throw new Error(`${rule}: the short drew no short mark`);
    expect(short.querySelector("svg[data-mark=hollow]"), rule).not.toBeNull();
    expect(short.className, rule).toMatch(/\btext-warn-11\b/);
    expect(short.textContent, rule).not.toMatch(/[≈✓]/);
    expect(short).toHaveAccessibleName("Short");
    expect([...proof.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["✓#1A nurse sees the reminder", "#2A nurse sees it on a phone"]);
  });
});

