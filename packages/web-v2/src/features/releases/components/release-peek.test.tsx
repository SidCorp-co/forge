// The release list's peek is its page's overview, shortened (REQ-40 BC-18): read from the same page
// endpoint, it shows the release's name, status and summary, its first changes whole with how many
// more the page holds, and one line on what it needs. catalog-api 0.1.0's peek read a second source:
// a title of issue titles joined by ";" and cut, "What changes" saying "10 issues name nothing
// structured", and Proof and Run.

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releasePage } from "@/test/release-page";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ReleasePeek } from "./release-peek";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.restoreAllMocks());

const peek = { open: "0.1.0", position: { at: 1, of: 1 }, set: () => {}, move: () => {} };

const DETAIL = {
  key: "0.1.0",
  version: "0.1.0",
  name: "ePOD deploy",
  summary: "Catalog giờ deploy được thiết kế lên cửa hàng ePOD. Cài đặt cửa hàng kiểm tra được kết nối.", // i18n-allow: catalog-api 0.1.0's own note, replayed as the test case
  state: "awaiting_approval",
  runId: "run-1",
  releasedAt: null,
  approval: null,
  approvalRequired: true,
  approvers: [{ id: "u", name: "orchestrator", kind: "agent" }],
  production: null,
  verified: { level: "criteria", proven: 10, total: 10, check: null, provider: null },
  criteria: { total: 10, proven: 10, failing: 0, open: 0, unproven: 0 },
  issues: [],
  gates: [],
  cuts: [],
  attempts: [],
  approvals: [],
  can: { cut: false, decide: false, split: false },
  attentionGroup: "needs_you",
  waitingOn: { kind: "none", who: "", act: "", rule: "r", ref: null, dueAt: null },
  // what the peek read before: the landing classifier's own account
  changes: {
    surfaces: [],
    risks: [],
    unclassified: Array.from({ length: 10 }, (_, i) => ({ key: `ISS-${i + 1}`, why: "its mark records no commit Forge observed", paths: [] })),
    boxRead: [],
    shipsNothing: false,
  },
};

const change = (n: number, section: "Added" | "Fixed") => ({
  issueKey: `ISS-${n}`,
  kind: section === "Added" ? ("new" as const) : ("fixed" as const),
  section,
  line: `Change ${n}, said whole as its note wrote it`,
  detail: `Sentence ${n}.`,
  requirementKey: null,
});

function serve() {
  const page = releasePage({
    header: { ...releasePage().header, version: "0.1.0", name: DETAIL.name, summary: DETAIL.summary, state: "awaiting_approval" },
    improvements: [1, 2, 3, 4, 5].map((n) => change(n, "Added")),
    fixes: [6, 7, 8, 9, 10].map((n) => change(n, "Fixed")),
  });
  return fakeCore((c) => {
    if (c.path === "/projects/p1/releases/0.1.0") return { body: { release: DETAIL } };
    if (c.path === "/projects/p1/releases/0.1.0/page?view=user") return { body: page };
    return undefined;
  });
}

describe("the release peek (REQ-40 BC-18)", () => {
  it("is the page's overview, shortened: its name, summary, eight changes whole and how many more", async () => {
    const calls = serve();
    renderWithQuery(<ReleasePeek projectId="p1" version="0.1.0" peek={peek} full={{ href: "/projects/hop/releases/0.1.0", origin: null }} />);
    expect(await screen.findByTestId("release-peek-title")).toHaveTextContent("0.1.0 · ePOD deploy");
    const overview = await screen.findByTestId("release-peek-overview");
    expect(within(overview).getByTestId("release-peek-summary")).toHaveTextContent(DETAIL.summary);
    const lines = within(overview).getAllByTestId("release-peek-change");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toHaveTextContent("NewChange 1, said whole as its note wrote it");
    expect(within(overview).getByTestId("release-peek-more")).toHaveTextContent("+2 more");
    // the same read its page makes, and no other
    expect(calls.some((c) => c.path === "/projects/p1/releases/0.1.0/page?view=user")).toBe(true);
  });

  it("says in one line what it needs before it goes out", async () => {
    serve();
    renderWithQuery(<ReleasePeek projectId="p1" version="0.1.0" peek={peek} full={{ href: "/projects/hop/releases/0.1.0", origin: null }} />);
    expect(await screen.findByTestId("release-peek-action")).toHaveTextContent(
      "2 steps before release · Next: Add a production environment, then approve",
    );
  });

  it("shows nothing of the pipeline: no What changes, no Unclassified, no Proof, no Run, no forecast", async () => {
    serve();
    renderWithQuery(<ReleasePeek projectId="p1" version="0.1.0" peek={peek} full={{ href: "/projects/hop/releases/0.1.0", origin: null }} />);
    const panel = await screen.findByTestId("release-peek");
    await screen.findByTestId("release-peek-overview");
    for (const word of ["What changes", "Unclassified", "name nothing structured", "records no commit", "Proof", "Forecast", "Not cut yet: no run"])
      expect(panel).not.toHaveTextContent(word);
    expect(screen.queryByTestId("release-facts")).toBeNull();
    expect(screen.queryByTestId("what-changes")).toBeNull();
  });
});
