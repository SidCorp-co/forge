// The release page's own screen: it opens on the user view, a switch shows the developer view with
// the operator's panes under it, and the reader is read from the page endpoint in the view chosen.

import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  notes: { sections: [], designs: [], withoutNotes: [], language: "en", attention: [] },
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
