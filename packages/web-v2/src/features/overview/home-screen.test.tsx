// ISS-919 (FB-483): the workspace home answers what waits on the person, what is moving for what
// they gave, and what is live, from core's reads. Waiting on you opens the act's own place; a Moving
// row with no held forecast says so in words, never a blank; the search answers a live item with
// its version and since when, and a moving one with its stage.
// @direct-test-of packages/web-v2/src/features/overview/components/home-screen.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/waiting-on-you.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/moving-work.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/live-releases.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/item-finder.tsx
// @direct-test-of packages/web-v2/src/features/overview/home-rows.ts

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
  opens: null,
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

const home: HomeResponse = {
  generatedAt: "2026-11-03T04:00:00.000Z",
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
  },
};

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push }) }));
vi.mock("@/features/attention", () => ({ useAttention: () => attention }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: "org-1", activeOrg: null }) }));
vi.mock("./hooks", () => ({
  HOME_FIND_MIN: 2,
  usePulse: () => ({ ...settled, data: undefined }),
  useHome: () => ({ ...settled, data: home }),
  useHomeFind: (q: string) => ({ ...settled, data: q.trim().length >= 2 ? (found[q.trim()] ?? { q, items: [] }) : undefined }),
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
    const row = screen.getByTestId("home-waiting-row");
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
});
