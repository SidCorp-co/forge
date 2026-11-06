// ISS-919 (FB-483), ISS-1069: the workspace home answers what is moving for what the person gave, the
// one thing Activity does not show. A Moving row with no held forecast says so in words, never a blank;
// a list core cut says how many it holds of how many; what nothing moved for a week folds under Idle,
// each with its age, a running item never.
// @direct-test-of packages/web-v2/src/features/overview/components/home-screen.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/moving-work.tsx
// @direct-test-of packages/web-v2/src/features/overview/home-rows.ts
// @direct-test-of packages/web-v2/src/features/overview/components/cut-note.tsx

import type { HomeResponse } from "@forge/contracts/owner-home";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderWithQuery as render } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
const settled = { isLoading: false, isError: false, error: null, refetch: vi.fn() };

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

const home: HomeResponse = {
  generatedAt: "2026-11-03T04:00:00.000Z",
  movingTotal: 132,
  movingTruncated: true,
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
  live: [],
};

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push }) }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: "org-1", activeOrg: null }) }));
vi.mock("./hooks", () => ({ useHome: () => ({ ...settled, data: home }) }));

import { HomeScreen } from "./components/home-screen";

beforeEach(() => {
  push.mockClear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
});

describe("the workspace home", () => {
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
});
