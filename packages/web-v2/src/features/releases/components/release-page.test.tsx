// The release page in the approved report shape (ISS-1001): its one proof number, what users see by
// screen with no key, commit, branch or change request on its face, what needs attention (absent when
// nothing does), everything technical behind one collapsed section, and the one act once, at the top.
// @direct-test-of packages/web-v2/src/features/releases/proof.ts
// @direct-test-of packages/web-v2/src/features/releases/release-report.ts
// @direct-test-of packages/web-v2/src/features/releases/components/release-proof.tsx

import type { ReleasePage as Page } from "@forge/contracts/release-page";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releasePage, TECHNICAL } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { rawKeysOnFace } from "@/test/screen-face";
import { ReleaseItemScreen } from "./release-item-screen";
import { ReleasePage } from "./release-page";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/forge/releases/0.4.0",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

const SHA = "c54e6b82".padEnd(40, "0");

const DETAIL = {
  key: "0.4.0",
  version: "0.4.0",
  name: "Readable releases",
  state: "draft",
  runId: null,
  head: SHA,
  approval: null,
  verified: { level: "some_criteria", proven: 2, total: 3, check: null, provider: null, judgedOn: "production" },
  issueCount: 2,
  issues: [
    {
      id: "i1",
      key: "ISS-1",
      title: "Release page",
      status: "awaiting_release",
      requirement: "REQ-40",
      proof: "proven",
      changeRequest: { label: "!2070", number: 2070, title: "feat(release): page", url: "https://git.example/mr/2070", state: "merged", order: null },
    },
  ],
  promotion: null,
  gates: [],
  cuts: [],
  attempts: [],
  approvals: [],
  criteria: { total: 3, proven: 2, failing: 0, open: 1, unproven: 0 },
  issueCriteria: [],
  requirementsCompleted: [],
  feedbackAnswered: [],
  feedbackToldCounts: { told: 0, not_told: 0, before_notices: 0, on_ship: 0 },
  corrections: [],
  notes: { sections: [], designs: [], withoutNotes: [], reworked: [], language: "en", attention: [] },
  changes: TECHNICAL.changes,
  production: null,
  continuedAs: null,
  can: { cut: true, decide: false, split: false },
  attentionGroup: "needs_you",
  waitingOn: { kind: "you", who: "You", act: "Cut 0.4.0", rule: "r", ref: null, dueAt: null },
};

const userPage = (over: Partial<Page> = {}) =>
  releasePage({
    header: { ...releasePage().header, state: "draft", verified: DETAIL.verified as Page["header"]["verified"] },
    improvements: [{ issueKey: "ISS-1", kind: "new", section: "Added", line: "Releases read as pages", detail: "Open any release and read it.", requirementKey: "REQ-40", screen: "Releases" }],
    fixes: [{ issueKey: "ISS-2", kind: "fixed", section: "Fixed", line: "Dates show correctly.", detail: null, requirementKey: null, screen: null }],
    ...over,
  });

function serve(page: Page = userPage(), detail: Record<string, unknown> = DETAIL) {
  return fakeCore((c) => {
    if (c.path === "/projects/p1/releases/0.4.0") return { body: { release: detail } };
    if (c.path === "/projects/p1/releases") return { body: { releases: [] } };
    if (c.path === "/projects/p1/releases/0.4.0/page?view=user") return { body: page };
    if (c.path === "/projects/p1/releases/0.4.0/page?view=developer") return { body: { ...page, view: "developer", technical: TECHNICAL } };
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

describe("the release page in the report shape (ISS-1001)", () => {
  it("draws its one proof number from the release's own count: proven of total, where it was judged", async () => {
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("release-report");
    const bars = screen.getAllByTestId("release-proof");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute("data-proven", "2");
    expect(bars[0]).toHaveAttribute("data-total", "3");
    expect(bars[0]).toHaveTextContent("2/3 criteria · on production");
    // no second count beside it, in the words either retired source used
    expect(document.body).not.toHaveTextContent(/checks met|criteria proven/);
  });

  it("groups what users see by screen, in the notes' words, with no key, commit, branch or change request on its face", async () => {
    serve();
    const { container } = renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("page-screens");
    const screens = screen.getAllByTestId("page-screen").map((s) => s.textContent);
    expect(screens[0]).toMatch(/^Releases.*Releases read as pages/);
    expect(screens[1]).toMatch(/Dates show correctly\./);
    expect(rawKeysOnFace(container)).toEqual([]);
    for (const word of ["!2070", "feat(release): page"]) expect(within(screen.getByTestId("release-detail")).queryByText(word, { exact: false })).toBeNull();
  });

  it("says what needs attention, the steps before it goes out and what is unproven, in one list", async () => {
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    const items = (await screen.findAllByTestId("page-attention-item")).map((i) => i.dataset.kind);
    expect(items).toEqual(["step", "step", "unproven"]);
    expect(screen.getByTestId("page-attention")).toHaveTextContent("1 of 3 criteria not proven on production");
  });

  it("leaves Needs attention out entirely when nothing needs it", async () => {
    serve(userPage({ actionRequired: [], header: { ...userPage().header, verified: { level: "criteria", proven: 3, total: 3, check: null, provider: null, judgedOn: null }, approval: { required: false, state: "not_asked", by: null, at: null } } }), {
      ...DETAIL,
      verified: { level: "criteria", proven: 3, total: 3, check: null, provider: null, judgedOn: null },
    });
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("page-screens");
    expect(screen.queryByTestId("page-attention")).toBeNull();
    expect(document.body).not.toHaveTextContent("Needs attention");
  });

  it("keeps change requests, the commit and the developer notes behind one collapsed Technical section", async () => {
    const calls = serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    const fold = await screen.findByTestId("release-technical-fold");
    expect(fold).not.toHaveAttribute("open");
    expect(screen.getByTestId("release-technical-summary")).toHaveTextContent("Technical · Change requests 1");
    expect(screen.queryByTestId("release-technical-body")).toBeNull();
    // the developer view is not read until the section is opened
    expect(calls.some((c) => c.path.endsWith("view=developer"))).toBe(false);
    (fold as HTMLDetailsElement).open = true;
    fireEvent(fold, new Event("toggle"));
    const body = await screen.findByTestId("release-technical-body");
    expect(body).toHaveTextContent(SHA.slice(0, 7));
    expect(await within(body).findByTestId("page-technical")).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("view=developer"))).toBe(true);
  });

  it("offers the one act once, in the header, and nowhere in the page under it", async () => {
    serve();
    renderWithQuery(<ReleaseItemScreen projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("release-report");
    expect(screen.getAllByTestId("release-actions")).toHaveLength(1);
    expect(screen.getAllByTestId("release-cut")).toHaveLength(1);
    expect(within(screen.getByTestId("release-detail")).queryByTestId("release-actions")).toBeNull();
  });

  it("says the next step once at the top only where the reader has no act to take on it", async () => {
    serve(userPage(), { ...DETAIL, state: "landed", landedOn: "release/stg", approvalRequired: true, can: { cut: false, decide: false, split: false } });
    const { unmount } = renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    expect(await screen.findByTestId("standing-next")).toHaveTextContent("Next: Have it judged on production first");
    unmount();
    serve();
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    await screen.findByTestId("release-report");
    expect(screen.queryByTestId("standing-next")).toBeNull();
  });
});

// QA 0.4.0-dev.220: the header said "8 of 22 criteria proven" while the list showed 5 proven + 15 not
// yet proven. The seeded set of release-page-range-e2e.test.ts, as core serves it: a pass, a short, a
// pass on an earlier build only, a fail, a proven criterion tracing no code, and one of an issue
// tracing no requirement. The page's one proof number and the roster behind Technical sum alike.
describe("the proof number and the Technical section's roster say one count (BC-5)", () => {
  const verified = { level: "some_criteria" as const, proven: 4, total: 6, check: null, provider: null, judgedOn: null };
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
        business: { total: 3, proven: [{ code: "BC-1", statement: "A nurse is reminded of the visit" }, { code: "BC-2", statement: "The reminder reaches a phone" }] },
      },
    ],
    untraced: { proven: [{ code: null, statement: "the list loads in a second", short: false, issueKey: "ISS-3", n: 1, countedUnderCutover: false }], unproven: 0 },
  });

  it("reads the same proven and total in the proof bar and the roster's rows", async () => {
    serve(page, { ...DETAIL, verified, criteria: { proven: 4, failing: 1, open: 1, unproven: 0, total: 6 } });
    renderWithQuery(<ReleasePage projectId="p1" slug="forge" version="0.4.0" />);
    const fold = await screen.findByTestId("release-technical-fold");
    expect(screen.getByTestId("release-proof")).toHaveAttribute("data-proven", "4");
    expect(screen.getByTestId("release-proof")).toHaveAttribute("data-total", "6");
    (fold as HTMLDetailsElement).open = true;
    fireEvent(fold, new Event("toggle"));
    await screen.findByTestId("page-requirements");
    // the requirement's 3 proven rows, the untraced one, and the 2 still open sum to the bar's 6
    expect(screen.getByTestId("page-requirement")).toHaveTextContent("3 checks trace to REQ-1");
    const open = screen.getAllByTestId("page-known-issue").map((r) => Number(within(r).getByText(/^\d+ open$/).textContent?.split(" ")[0]));
    expect(3 + (page.untraced?.proven.length ?? 0) + open.reduce((a, b) => a + b, 0)).toBe(6);
    // a roster row marks each criterion by its number on its issue (REQ-43 BC-7, BC-10)
    const iss2 = screen.getAllByTestId("page-change").find((r) => r.getAttribute("data-row-key") === "ISS-2");
    if (!iss2) throw new Error("no ISS-2 row");
    fireEvent.click(within(iss2).getAllByRole("button")[0]);
    const lines = [...within(iss2).getByTestId("page-row-detail").querySelectorAll("li")].map((l) => l.textContent);
    expect(lines).toEqual(["✓#1(REQ-1 BC-2) the reminder names the patient"]);
  });
});
