// @vitest-environment jsdom
//
// ISS-1264 — the inbox is one scrolling list: rows are drawn as they come into view, the next 25 are
// asked for as the end of what is loaded does, and nothing is paged. jsdom has no layout, so the
// frame is stubbed at 600px with 80px rows and these tests assert wiring (what is drawn, what is
// asked, where focus goes); how it reads at 390px and 1280px is the browser walk's.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { createQueryClient } from "@/providers/query-provider";
import { stubLayout } from "@/test-support/layout";
import type { NotificationRow } from "../types";

expect.extend(matchers);

const server = vi.hoisted(() => ({
  total: 0,
  ask: (_page: number) => Promise.resolve({ items: [] as NotificationRow[], totalCount: 0 }),
}));

vi.mock("../api", async (original) => {
  const api = await original<typeof import("../api")>();
  return { ...api, settingsApi: { ...api.settingsApi, listNotifications: (page: number) => server.ask(page) } };
});
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock("../hooks", async (original) => {
  const hooks = await original<typeof import("../hooks")>();
  return {
    ...hooks,
    usePreferences: () => ({ data: { notifyOnMention: true }, isLoading: false, isError: false }),
    useUpdatePreferences: () => ({ mutate: () => {}, isPending: false }),
  };
});

import { NotificationsTab } from "./notifications-tab";

const FRAME = 600;
const ROW = 80;
const PAGE = 25;
let restore: () => void;

beforeEach(() => {
  restore = stubLayout((el) => {
    if (el.firstElementChild?.getAttribute("role") === "feed") return { width: 400, height: FRAME };
    if (el.tagName === "ARTICLE") return { width: 400, height: ROW };
    return undefined;
  });
});
afterEach(() => {
  cleanup();
  restore();
});

const row = (n: number, over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: `n${n}`,
  notificationId: `x${n}`,
  projectId: null,
  type: "status",
  kind: "status",
  title: `Notification ${n}`,
  body: null,
  readAt: null,
  members: 1,
  openMembers: 1,
  resolvedNotice: false,
  issueId: null,
  agentSessionId: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  ...over,
});

/** A server holding `total` notifications, newest first, that answers a page of 25. */
function serving(total: number, asked: number[] = []) {
  server.ask = async (page) => {
    asked.push(page);
    const from = (page - 1) * PAGE;
    return {
      items: Array.from({ length: Math.max(0, Math.min(PAGE, total - from)) }, (_, i) => row(from + i + 1)),
      totalCount: total,
    };
  };
  return asked;
}

function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationsTab />
    </QueryClientProvider>,
  );
}

/** The app's own query client, with its retries kept and their wait taken out, so a 5xx is asked as often as it is in the app. */
function openOnTheAppsPolicy() {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationsTab />
    </QueryClientProvider>,
  );
}

const articles = () => screen.queryAllByRole("article");
const feed = () => screen.getByRole("feed", { name: "Notifications" });
const scroller = () => feed().parentElement as HTMLElement;

async function loaded() {
  await screen.findByRole("feed", { name: "Notifications" });
  await act(async () => {});
}
async function scrollTo(top: number) {
  await act(async () => {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
  });
}

describe("the inbox of 1,300", () => {
  it("is one scrolling list with no page control, that says how many it holds", async () => {
    serving(1300);
    open();
    await loaded();
    expect(screen.getByText("1,300 notifications")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous page" })).toBeNull();
    expect(screen.queryByText(/\/ 52/)).toBeNull();
  });

  it("draws the rows in view and not the 25 it holds, each at its place among all 1,300", async () => {
    serving(1300);
    open();
    await loaded();
    expect(articles().length).toBeGreaterThan(5);
    expect(articles().length).toBeLessThan(PAGE);
    expect(articles()[0]).toHaveAttribute("aria-posinset", "1");
    expect(articles()[0]).toHaveAttribute("aria-setsize", "1300");
    expect(articles()[0]).toHaveAccessibleName("Notification 1");
  });

  it("asks for nothing more while the end of the first 25 is out of view", async () => {
    const asked = serving(1300);
    open();
    await loaded();
    expect(asked).toEqual([1]);
  });

  it("asks for the second 25 once, as the end of the first comes into view, and goes on from there", async () => {
    const asked = serving(1300);
    open();
    await loaded();
    await scrollTo(ROW * PAGE);
    await waitFor(() => expect(asked).toEqual([1, 2]));
    await act(async () => {});
    await scrollTo(ROW * PAGE * 2);
    await waitFor(() => expect(asked).toEqual([1, 2, 3]));
    expect(screen.getAllByRole("article").every((a) => a.getAttribute("aria-setsize") === "1300")).toBe(true);
  });

  it("holds a notification that moved down a page once, where it first appeared", async () => {
    const asked: number[] = [];
    server.ask = async (page) => {
      asked.push(page);
      const from = page === 1 ? 0 : PAGE - 1;
      return { items: Array.from({ length: PAGE }, (_, i) => row(from + i + 1)), totalCount: 1300 };
    };
    open();
    await loaded();
    await scrollTo(ROW * PAGE);
    await waitFor(() => expect(asked).toEqual([1, 2]));
    await act(async () => {});
    await scrollTo(ROW * (PAGE - 2));
    expect(screen.getAllByText("Notification 25")).toHaveLength(1);
    const places = articles().map((a) => a.getAttribute("aria-posinset"));
    expect(new Set(places).size).toBe(places.length);
  });

  it("is walked from row to row by PageDown, and to the last loaded row by Ctrl+End", async () => {
    serving(1300);
    open();
    await loaded();
    const first = articles()[0] as HTMLElement;
    act(() => first.focus());
    await act(async () => void fireEvent.keyDown(first, { key: "PageDown" }));
    expect(document.activeElement).toHaveAccessibleName("Notification 2");
    await act(async () => void fireEvent.keyDown(document.activeElement as Element, { key: "End", ctrlKey: true }));
    expect(document.activeElement).toHaveAccessibleName(`Notification ${PAGE}`);
  });
});

describe("the inbox at its edges", () => {
  it("says it is empty, with no list at all", async () => {
    serving(0);
    open();
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.queryByRole("feed")).toBeNull();
    expect(screen.queryByText(/^[\d,]+ notifications?$/)).toBeNull();
  });

  it("draws one row, says \"1 notification\", and asks for nothing after it", async () => {
    const asked = serving(1);
    open();
    await loaded();
    expect(articles()).toHaveLength(1);
    expect(screen.getByText("1 notification")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(asked).toEqual([1]);
  });

  it("shows exactly the rows of an inbox that fits in one page, with no loading row", async () => {
    serving(PAGE);
    open();
    await loaded();
    await scrollTo(ROW * PAGE);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("feed")).not.toHaveAttribute("aria-busy");
  });

  it("names a failed load of the first rows, with a way to try again", async () => {
    server.ask = () => Promise.reject(new Error("down"));
    open();
    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
    expect(screen.queryByRole("feed")).toBeNull();
  });

  it("keeps the rows it has when the next 25 fail, says so beside Retry, and asks again only when told to", async () => {
    const asked: number[] = [];
    let failing = true;
    server.ask = async (page) => {
      asked.push(page);
      if (page === 2 && failing) throw new Error("down");
      const from = (page - 1) * PAGE;
      return { items: Array.from({ length: PAGE }, (_, i) => row(from + i + 1)), totalCount: 1300 };
    };
    open();
    await loaded();
    await scrollTo(ROW * PAGE);
    await screen.findByText("Couldn't load more.");
    await act(async () => {});
    await act(async () => {});
    expect(asked).toEqual([1, 2]);
    expect(articles().length).toBeGreaterThan(0);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(asked).toEqual([1, 2, 2]));
    await waitFor(() => expect(screen.queryByText("Couldn't load more.")).toBeNull());
  });
});

describe("a failed ask for the next 25, on the query client the app runs", () => {
  it("is asked once, then waits for Retry, and each press of Retry asks once more", async () => {
    const asked: number[] = [];
    let failing = true;
    server.ask = async (page) => {
      asked.push(page);
      if (page === 2 && failing) throw new ApiError(503, "unavailable");
      const from = (page - 1) * PAGE;
      return { items: Array.from({ length: PAGE }, (_, i) => row(from + i + 1)), totalCount: 1300 };
    };
    openOnTheAppsPolicy();
    await loaded();
    await scrollTo(ROW * PAGE);
    await screen.findByText("Couldn't load more.");
    // Long enough for the client's own retries, had it been left to make them.
    await act(async () => {
      await new Promise((later) => setTimeout(later, 150));
    });
    expect(asked).toEqual([1, 2]);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Couldn't load more.");
    await act(async () => {
      await new Promise((later) => setTimeout(later, 150));
    });
    expect(asked).toEqual([1, 2, 2]);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Couldn't load more.")).toBeNull());
    expect(asked).toEqual([1, 2, 2, 2]);
  });

  it("keeps the client's retries for the first rows, which have no Retry beside them yet", async () => {
    const asked: number[] = [];
    server.ask = async (page) => {
      asked.push(page);
      throw new ApiError(503, "unavailable");
    };
    openOnTheAppsPolicy();
    expect(await screen.findByText("Couldn't load notifications")).toBeInTheDocument();
    expect(asked).toEqual([1, 1, 1]);
  });
});

describe("Mark all read", () => {
  it("is off when every loaded row is read", async () => {
    server.ask = async () => ({ items: [row(1, { readAt: "2026-10-01T11:00:00.000Z" })], totalCount: 1 });
    open();
    await loaded();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });

  it("is on while a loaded row is unread", async () => {
    serving(3);
    open();
    await loaded();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeEnabled();
  });
});
