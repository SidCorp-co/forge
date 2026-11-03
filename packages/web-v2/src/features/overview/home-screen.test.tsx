// ISS-919 (FB-483): the workspace home answers what waits on the person, what is moving for what
// they gave, and what is live, from core's reads. Waiting on you opens the act's own place; a Moving
// row with no held forecast says so in words, never a blank; the search answers a live item with
// its version and since when, and a moving one with its stage. A list core cut says how many it holds
// of how many; what nothing moved for a week folds under Idle, each with its age, a running item never;
// an item the person owes is a Waiting row beside the needs-you decisions, never a Moving one.
// @direct-test-of packages/web-v2/src/features/overview/components/home-screen.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/waiting-on-you.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/moving-work.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/live-releases.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/item-finder.tsx
// @direct-test-of packages/web-v2/src/features/overview/home-rows.ts
// @direct-test-of packages/web-v2/src/features/overview/components/cut-note.tsx

import type { HomeFindResponse, HomeResponse } from "@forge/contracts/owner-home";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderWithQuery as render } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const settled = { isLoading: false, isError: false, error: null, refetch: vi.fn() };

const decision = {
  id: "q:1",
  group: "answer",
  area: "development",
  entity: "question",
  key: "q-1",
  title: "Which login provider ships first?",
  // the decision is about an issue the person also owes: one row, the decision's
  opens: { kind: "issue", key: "ISS-77" },
  question: "Which login provider ships first?",
  changes: "-",
  impact: "-",
  recommended: null,
  noRecommendation: "none",
  answers: [],
  touchedAt: null,
  stuck: false,
  dueAt: null,
};
const attention = {
  view: {
    needsYou: [{ projectSlug: "shop", projectName: "Shop", total: 1, decisions: [decision] }],
    mentions: [],
    failedJobs: [],
    channelGates: [],
    statusReports: [],
    offlineRunners: [],
    counts: { mentions: 0, failedJobs: 0, channelGates: 0, statusReports: 0, offlineRunners: 0 },
    waitingOnYou: 1,
    total: 1,
  },
  ...settled,
};

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const home: HomeResponse = {
  generatedAt: "2026-11-03T04:00:00.000Z",
  movingTotal: 132,
  movingTruncated: true,
  waiting: [
    { kind: "feedback", key: "FB-469", title: "Search forgets my filter", projectSlug: "forge", projectName: "Forge", act: "triage it" },
    { kind: "issue", key: "ISS-77", title: "Login provider order", projectSlug: "shop", projectName: "Shop", act: "answer a question" },
  ],
  moving: [
    {
      kind: "feedback",
      key: "FB-483",
      title: "The UI answers nothing I ask",
      projectSlug: "forge",
      projectName: "Forge",
      stage: "building",
      running: true,
      owes: { who: "Agent", act: "build" },
      likelyBy: null,
      noDate: "no forecast: too little history",
      lastMovedAt: daysAgo(0),
      idle: false,
    },
    {
      kind: "issue",
      key: "ISS-12",
      title: "Checkout keeps the cart",
      projectSlug: "shop",
      projectName: "Shop",
      stage: "planned",
      running: false,
      owes: null,
      likelyBy: "2026-11-07T00:00:00.000Z",
      noDate: null,
      lastMovedAt: daysAgo(1),
      idle: false,
    },
    {
      // a run works on it, so it is never idle however long ago it last moved
      kind: "issue",
      key: "ISS-31",
      title: "Nightly import runs again",
      projectSlug: "shop",
      projectName: "Shop",
      stage: "building",
      running: true,
      owes: { who: "Agent", act: "build" },
      likelyBy: null,
      noDate: "no forecast",
      lastMovedAt: daysAgo(30),
      idle: false,
    },
    {
      kind: "feedback",
      key: "FB-86",
      title: "Export misses the header row",
      projectSlug: "forge",
      projectName: "Forge",
      stage: "new",
      running: false,
      owes: { who: "Project master", act: "triage it" },
      likelyBy: null,
      noDate: "it is not triaged yet",
      lastMovedAt: daysAgo(21),
      idle: true,
    },
  ],
  live: [
    {
      projectSlug: "forge",
      projectName: "Forge",
      environment: "production",
      environmentName: "dev",
      version: "0.4.0-dev.457",
      name: "Live Build Checklist Clarity",
      at: "2026-11-03T03:51:39.780Z",
      mine: 2,
    },
  ],
};

const found: Record<string, HomeFindResponse> = {
  "ISS-9": {
    q: "ISS-9",
    items: [
      {
        kind: "issue",
        key: "ISS-9",
        title: "Sign-in remembers the device",
        projectSlug: "forge",
        projectName: "Forge",
        standing: { kind: "live", environment: "production", version: "0.4.0-dev.450", since: "2026-11-02T15:06:30.361Z" },
      },
    ],
    total: 1,
    truncated: false,
  },
  "ISS-12": {
    q: "ISS-12",
    items: [
      {
        kind: "issue",
        key: "ISS-12",
        title: "Checkout keeps the cart",
        projectSlug: "shop",
        projectName: "Shop",
        standing: { kind: "moving", stage: "planned" },
      },
    ],
    total: 1,
    truncated: false,
  },
};

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push }) }));
vi.mock("@/features/attention", () => ({ useAttention: () => attention }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: "org-1", activeOrg: null }) }));
vi.mock("./hooks", () => ({
  HOME_FIND_MIN: 2,
  usePulse: () => ({ ...settled, data: undefined }),
  useHome: () => ({ ...settled, data: home }),
  useHomeFind: (q: string) => ({ ...settled, data: q.trim().length >= 2 ? (found[q.trim()] ?? { q, items: [], total: 0, truncated: false }) : undefined }),
}));

import { HomeScreen } from "./components/home-screen";

beforeEach(() => {
  push.mockClear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the workspace home", () => {
  it("draws its three sections in order: waiting on you, moving, live", () => {
    render(<HomeScreen />);
    const titles = ["Waiting on you", "Moving", "Live"].map((n) => screen.getByRole("heading", { name: n }));
    const [a, b, c] = titles;
    expect(a?.compareDocumentPosition(b as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(b?.compareDocumentPosition(c as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole("tab", { name: "Figures" })).toBeTruthy();
  });

  it("opens the act's own place from a waiting row, and shows no raw key as text", () => {
    render(<HomeScreen />);
    const [row] = screen.getAllByTestId("home-waiting-row");
    if (!row) throw new Error("no waiting row");
    expect(within(row).getByText("Question")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Answer" }));
    expect(push).toHaveBeenCalledWith("/projects/shop/approvals?peek=question%3Aq-1");
    expect(row.textContent).not.toContain("q-1");
  });

  it("says a Moving row has no date in words where no forecast is held, and gives the held one where it is", () => {
    render(<HomeScreen />);
    const [noForecast, dated] = screen.getAllByTestId("home-moving-row") as [HTMLElement, HTMLElement];
    const noDate = within(noForecast).getByTestId("home-moving-date");
    expect(noDate.textContent).toBe("No date");
    expect(noDate.getAttribute("title")).toBe("no forecast: too little history");
    expect(within(dated).getByTestId("home-moving-date").textContent).toMatch(/^by /);
    // a run working on it now shows as live; who owes the next move is named, or said to be nobody
    expect(within(noForecast).getByText("Agent · build")).toBeTruthy();
    expect(within(dated).getByText("Nobody named")).toBeTruthy();
    expect(noForecast.textContent).not.toContain("FB-483");
  });

  it("lists each latest release with its environment and how many of the person's items it carried", () => {
    render(<HomeScreen />);
    const row = screen.getByTestId("home-live-row");
    expect(row.getAttribute("data-environment")).toBe("production");
    expect(within(row).getByText("Live Build Checklist Clarity")).toBeTruthy();
    expect(within(row).getByText("Production")).toBeTruthy();
    expect(within(row).getByText("2 yours")).toBeTruthy();
  });

  it("answers a live item with its version and since when, and a moving one with its stage", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HomeScreen />);
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "ISS-9" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId("home-found-says").textContent).toMatch(/^Live on production since .+ in 0\.4\.0-dev\.450 · Forge$/);
    fireEvent.change(box, { target: { value: "ISS-12" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId("home-found-says").textContent).toBe("Planned · Shop");
  });

  it("lists Waiting from the needs-you read, then the person's own items, one row an item", () => {
    render(<HomeScreen />);
    const rows = screen.getAllByTestId("home-waiting-row");
    // the needs-you decision first; the owed ISS-77 it is about is not listed twice
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "Which login provider ships first?",
      "Search forgets my filter",
    ]);
    const [, owed] = rows;
    if (!owed) throw new Error("the owed row is missing");
    expect(within(owed).getByText("Your move")).toBeTruthy();
    fireEvent.click(within(owed).getByRole("button", { name: "Open" }));
    expect(push).toHaveBeenCalledWith("/projects/forge/feedback/FB-469");
    expect(owed.textContent).not.toContain("FB-469");
  });

  it("never shows an item the person owes under Moving", () => {
    render(<HomeScreen />);
    const moving = screen.getByTestId("home-moving");
    expect(within(moving).queryByText("Search forgets my filter")).toBeNull();
    expect(within(screen.getByTestId("home-waiting")).getByText("Search forgets my filter")).toBeTruthy();
  });

  it("says a cut Moving list holds how many of how many", () => {
    render(<HomeScreen />);
    expect(within(screen.getByTestId("home-moving")).getByTestId("home-cut").textContent).toBe("4 of 132");
  });

  it("folds what nothing moved for a week under one Idle row, which opens to each with its age in words", () => {
    render(<HomeScreen />);
    const moving = screen.getByTestId("home-moving");
    const titles = () => screen.getAllByTestId("home-moving-row").map((r) => within(r).getByRole("link").textContent);
    expect(titles()).not.toContain("Export misses the header row");
    // a running item is never folded, however long ago it moved
    expect(titles()).toContain("Nightly import runs again");
    const idle = within(moving).getByTestId("home-moving-idle");
    expect(idle.textContent).toBe("Idle (1)");
    expect(idle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(idle);
    const list = within(moving).getByTestId("home-moving-idle-list");
    const row = within(list).getByTestId("home-moving-row");
    expect(within(row).getByRole("link").textContent).toBe("Export misses the header row");
    expect(within(row).getByTestId("home-moving-age").textContent).toBe("21d ago");
    expect(within(list).queryByText("Nightly import runs again")).toBeNull();
  });

  it("says a cut search holds how many of how many", () => {
    found.issue = {
      q: "issue",
      items: found["ISS-12"]?.items ?? [],
      total: 52,
      truncated: true,
    };
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HomeScreen />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "issue" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(within(screen.getByTestId("home-find")).getByTestId("home-cut").textContent).toBe("1 of 52");
  });
});
