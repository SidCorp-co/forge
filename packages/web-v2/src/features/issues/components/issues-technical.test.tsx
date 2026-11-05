// The technical backlog is a filter on the Issues list, never a screen of its own (ISS-1001, owner
// ruling 2026-11-05): its chip keeps the drafts an agent filed under a technical kind, groups them by
// module with "No module" as its own group, and counts each module's items by kind.

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

function board() {
  window.history.replaceState(null, "", "/projects/demo/issues");
  fakeCore((c) =>
    c.path.startsWith("/projects/p1/issues/standing")
      ? { body: { issues: ROWS, counts: { open: 8, closed: 0, all: 8, blocked: 0, blocking: 0 }, returned: 8, limit: 500, releaseApproval: false } }
      : { body: {} },
  );
  return renderWithQuery(<IssuesBoard scope={{ projectId: "p1", slug: "demo" }} mode="attention" />);
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
