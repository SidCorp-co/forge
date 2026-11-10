// The technical backlog is a filter on the Issues list, never a screen of its own (ISS-1001, owner
// ruling 2026-11-05): its chip keeps the drafts an agent filed under a technical kind, groups them by
// module with "No module" as its own group, and counts each module's items by kind.
//
// @direct-test-of packages/web-v2/src/features/issues/components/issues-band.tsx
// @direct-test-of packages/web-v2/src/features/issues/api.ts

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyLocationChange } from "@/lib/utils/use-location-search";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { IssuesBoard } from "./issues-board";

const go = (href: string) => {
  window.history.pushState(null, "", href);
  notifyLocationChange();
};
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({
  useRouter: () => ({ push: go, replace: go }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/lib/i18n/eta-clock", () => ({ useEtaClock: () => ({ lang: "en", now: Date.parse("2026-11-05T12:00:00Z") }) }));
vi.mock("@/features/forecast/hooks", () => ({ useEtaSort: () => [false, () => {}], useProjectForecast: () => ({ data: undefined }) }));

const AT = "2026-11-01T10:00:00.000Z";
function issue(n: number, category: string | null, byAgent: boolean, module: string | null, status = "draft"): IssueStandingRow {
  const r = {
    id: `i${n}`,
    key: `ISS-${n}`,
    title: `Issue ${n}`,
    writtenLang: null,
    status,
    priority: "medium",
    category,
    complexity: "s",
    assigneeId: null,
    createdById: "u1",
    byAgent,
    createdAt: AT,
    updatedAt: AT,
    standing: {
      state: "draft",
      step: null,
      stepStartedAt: null,
      moves: [],
      tone: "ready",
      attentionGroup: "queued",
      waitingOn: waitingOn("master", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE }),
      criteria: { total: 0, met: 0, failing: 0, skipped: 0 },
      requirement: null,
      module: module ? { id: `m-${module}`, path: module } : null,
      feedback: [],
      blockedBy: [],
      blocks: [],
      lease: null,
      inFlight: false,
      branch: null,
      headSha: null,
      owner: null,
      wave: null,
      touchedAt: AT,
      withheld: null,
    },
  };
  return r as unknown as IssueStandingRow;
}

const ROWS = [
  issue(1, "bug", true, "Paygate"),
  issue(2, "bug", true, "Paygate"),
  issue(3, "security", true, "Paygate"),
  issue(4, "debt", true, null),
  // a person's bug, an agent's feature and an admitted bug are not the technical backlog
  issue(5, "bug", false, "Paygate"),
  issue(6, "feature", true, "Paygate"),
  issue(7, "performance", true, "Orders"),
  issue(8, "bug", true, "Orders", "open"),
];

/** Two days of the flow: three filed and one closed the day before, two closed today. */
const FLOW = [
  { day: "2026-11-04", opened: 3, closed: 1 },
  { day: "2026-11-05", opened: 0, closed: 2 },
];

function board(mode: "attention" | "waves" = "attention", issues: IssueStandingRow[] = ROWS) {
  window.history.replaceState(null, "", "/projects/demo/issues");
  fakeCore((c) => {
    if (c.path.startsWith("/projects/p1/issues/flow")) return { body: { projectId: "p1", tz: "UTC", days: FLOW } };
    return c.path.startsWith("/projects/p1/issues/standing")
      ? { body: { issues, counts: { open: issues.length, closed: 0, all: issues.length, blocked: 0, blocking: 0 }, returned: issues.length, limit: 500, releaseApproval: false } }
      : { body: {} };
  });
  return renderWithQuery(<IssuesBoard scope={{ projectId: "p1", slug: "demo" }} mode={mode} />);
}

const rows = () => screen.queryAllByTestId("list-row").map((r) => r.getAttribute("data-key"));

afterEach(() => vi.unstubAllGlobals());

describe("the Issues list's Technical chip (ISS-1001)", () => {
  it("counts the agent-filed technical items on its chip, and keeps only them once on", async () => {
    board();
    await waitFor(() => expect(rows()).toHaveLength(8));
    const chip = screen.getByTestId("quick-technical");
    expect(chip).toHaveTextContent("Technical");
    expect(chip).toHaveTextContent("5");
    fireEvent.click(chip);
    await waitFor(() => expect(rows().sort()).toEqual(["ISS-1", "ISS-2", "ISS-3", "ISS-4", "ISS-7"]));
    expect(window.location.search).toContain("technical");
  });

  it("groups them by module, No module its own group last, each counted by kind", async () => {
    board();
    await waitFor(() => expect(rows()).toHaveLength(8));
    fireEvent.click(screen.getByTestId("quick-technical"));
    await waitFor(() => expect(rows()).toHaveLength(5));
    const groups = screen.getAllByTestId("list-group").map((g) => within(g).getByTestId("group-label").textContent);
    expect(groups).toEqual(["Orders", "Paygate", "No module"]);
    const paygate = screen.getAllByTestId("list-group")[1];
    expect(paygate).toHaveTextContent("Bug 2");
    expect(paygate).toHaveTextContent("Security 1");
    expect(screen.getAllByTestId("list-group")[2]).toHaveTextContent("Debt 1");
  });
});

// REQ-43 r3 BC-14 (owner, 2026-11-10): the list opens on its overview, its status counts the rows the
// list holds (L-57), and its chart is how the issues moved, read from the flow beside the list
describe("the Issues list's overview band", () => {
  it("sits above the list, its status counts summing to the list's groups, its chart the flow's", async () => {
    board();
    await waitFor(() => expect(rows()).toHaveLength(8));
    const band = screen.getByTestId("issues-band");
    const list = screen.getByTestId("grouped-list");
    expect(band.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const flow = within(band).getAllByTestId("coverage-part-count").map((c) => Number(c.textContent));
    const groups = within(list).getAllByTestId("group-count").map((c) => Number(c.textContent));
    expect(flow.reduce((a, b) => a + b, 0)).toBe(groups.reduce((a, b) => a + b, 0));
    await waitFor(() => expect(within(band).getByTestId("issues-band-chart")).toBeInTheDocument());
    const closed = within(band).getAllByTestId("band-figure").find((f) => f.dataset.key === "closed");
    expect(within(closed as HTMLElement).getByTestId("band-figure-value")).toHaveTextContent("3");
  });
});

// Raw keys never lead the Issues list (ISS-1072): each row leads with its title, its key the title's
// tooltip, and the header names no Key column
describe("the Issues list's rows", () => {
  it("lead with the title, the key only in its tooltip", async () => {
    board();
    await waitFor(() => expect(rows()).toHaveLength(8));
    const first = screen.getAllByTestId("list-row")[0];
    expect(first?.textContent?.startsWith("Issue ")).toBe(true);
    expect(first?.textContent).not.toContain("ISS-");
    expect(first?.querySelector("[title^='ISS-']")).not.toBeNull();
    expect(screen.getByTestId("list-header").textContent).not.toContain("Key");
  });

  it("read Unassigned where core names no owner, as for one an agent account filed from no box", async () => {
    board();
    await waitFor(() => expect(rows()).toHaveLength(8));
    expect(screen.getAllByTestId("list-row")[0]).toHaveTextContent("Unassigned");
  });
});

// The Waves view leads each card with the issue's title too, never its key (ISS-1072 round 2): the key
// is the card's tooltip, as on the list.
describe("the Waves view's cards", () => {
  it("lead with the title, the key only in the card's tooltip", async () => {
    const waved = ROWS.slice(0, 2).map((r) => ({ ...r, standing: { ...r.standing, wave: 0 } }));
    board("waves", waved);
    const cards = await screen.findAllByTestId("wave-card");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.textContent?.startsWith("Issue ")).toBe(true);
      expect(card.textContent).not.toContain("ISS-");
      expect(card.getAttribute("title")).toMatch(/^ISS-\d+$/);
    }
  });
});
