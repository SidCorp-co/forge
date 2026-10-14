// @vitest-environment jsdom
//
// ISS-1264 — the inbox is one scrolling list: rows are drawn as they come into view, the next 25 are
// asked for as the end of what is loaded does, and nothing is paged. jsdom has no layout, so the
// frame is stubbed at 600px with 80px rows and these tests assert wiring (what is drawn, what is
// asked, where focus goes); how it reads at 390px and 1280px is the browser walk's.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { createQueryClient } from "@/providers/query-provider";
import { stubLayout } from "@/test-support/layout";
import type { InboxFilter } from "@/features/notifications/api";
import type { NotificationMember, NotificationRow } from "@/features/notifications/types";

expect.extend(matchers);

const server = vi.hoisted(() => ({
  total: 0,
  ask: (_page: number, _filter?: InboxFilter) =>
    Promise.resolve({ items: [] as NotificationRow[], totalCount: 0 }),
  members: (_id: string) => Promise.resolve([] as NotificationMember[]),
}));

vi.mock("@/features/notifications/api", async (original) => {
  const api = await original<typeof import("@/features/notifications/api")>();
  return {
    ...api,
    notificationsApi: {
      ...api.notificationsApi,
      inbox: (page: number, filter: InboxFilter) => server.ask(page, filter),
      members: (id: string) => server.members(id),
      markRead: () => Promise.resolve({}),
    },
  };
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
  explanation: null,
  unread: true,
  members: 1,
  openMembers: 1,
  resolvedNotice: false,
  projectSlug: null,
  projectName: null,
  issueId: null,
  secondaryIssueId: null,
  agentSessionId: null,
  groupKey: null,
  tier: "log",
  severity: null,
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
    server.ask = async () => ({
      items: [row(1, { readAt: "2026-10-01T11:00:00.000Z", unread: false })],
      totalCount: 1,
    });
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

describe("a row names what it is about and opens it", () => {
  const ISSUE = "11111111-1111-4111-8111-111111111111";

  it("is a link to its issue, titled by the issue and not by the cause that found it", async () => {
    server.ask = async () => ({
      items: [
        row(1, {
          type: "issue_stranded",
          title: 'ISS-41 shipped but never closed — Invoicing',
          body: 'ISS-41 "Repair invoice export" has carried a merge mark for 2 days.',
          projectSlug: "invoicing",
          projectName: "Invoicing",
          issueId: ISSUE,
        }),
      ],
      totalCount: 1,
    });
    open();
    await loaded();
    const link = screen.getByRole("link", { name: "ISS-41 shipped but never closed — Invoicing" });
    expect(link).toHaveAttribute("href", `/projects/invoicing/issues/${ISSUE}`);
    expect(link.className).toContain("min-h-11");
    expect(screen.getByText("Invoicing · Stranded issues")).toBeInTheDocument();
  });

  it("opens its project where it names no issue, and is plain text where it names no project", async () => {
    server.ask = async () => ({
      items: [
        row(1, { type: "pipeline_wedge", title: "A runner can no longer authenticate", projectSlug: "invoicing" }),
        row(2, { type: "ops_alert", title: "Disk is nearly full" }),
      ],
      totalCount: 2,
    });
    open();
    await loaded();
    expect(screen.getByRole("link", { name: "A runner can no longer authenticate" })).toHaveAttribute(
      "href",
      "/projects/invoicing",
    );
    expect(screen.queryByRole("link", { name: "Disk is nearly full" })).toBeNull();
    expect(screen.getByText("Disk is nearly full")).toBeInTheDocument();
  });

  it("reads a row read when it is opened", async () => {
    server.ask = async () => ({
      items: [row(1, { title: "ISS-5 is wedged", projectSlug: "invoicing", issueId: ISSUE })],
      totalCount: 1,
    });
    const marked: string[] = [];
    const { notificationsApi } = await import("@/features/notifications/api");
    notificationsApi.markRead = (id: string) => {
      marked.push(id);
      return Promise.resolve({} as NotificationRow);
    };
    open();
    await loaded();
    fireEvent.click(screen.getByRole("link", { name: "ISS-5 is wedged" }));
    await waitFor(() => expect(marked).toEqual(["n1"]));
  });
});

describe("a sweep's row", () => {
  const group = (over: Partial<NotificationRow> = {}) =>
    row(1, {
      type: "issue_stranded",
      title: "Issues whose code shipped and whose close was never written",
      explanation: "The step that owed the close did not write it.",
      projectSlug: "invoicing",
      projectName: "Invoicing",
      members: 3,
      openMembers: 2,
      groupKey: "sweep:owed-close:1",
      ...over,
    });
  const member = (n: number, over: Partial<NotificationMember> = {}): NotificationMember => ({
    id: `m${n}`,
    type: "issue_stranded",
    kind: "condition",
    state: "firing",
    title: `ISS-4${n} shipped but never closed — Invoicing`,
    body: null,
    severity: null,
    projectId: "p1",
    projectSlug: "invoicing",
    projectName: "Invoicing",
    issueId: `00000000-0000-4000-8000-00000000000${n}`,
    secondaryIssueId: null,
    resolvedAt: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    open: true,
    ...over,
  });

  it("is titled by its cause with its count, and opens nothing itself", async () => {
    server.ask = async () => ({ items: [group()], totalCount: 1 });
    open();
    await loaded();
    expect(screen.getByText("Issues whose code shipped and whose close was never written")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "2 of 3 still open — show" })).toBeInTheDocument();
    expect(screen.queryByText("The step that owed the close did not write it.")).toBeNull();
  });

  it("expands to its members, each a link to its own issue, with the explanation said once", async () => {
    server.ask = async () => ({ items: [group()], totalCount: 1 });
    server.members = async () => [member(1), member(2), member(3, { open: false })];
    open();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "2 of 3 still open — show" }));
    expect(await screen.findByRole("link", { name: "ISS-41 shipped but never closed — Invoicing" })).toHaveAttribute(
      "href",
      "/projects/invoicing/issues/00000000-0000-4000-8000-000000000001",
    );
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.getAllByText("The step that owed the close did not write it.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "2 of 3 still open — hide" })).toHaveAttribute("aria-expanded", "true");
  });

  it("says what a single record's sweep means behind a disclosure, not on the row", async () => {
    server.ask = async () => ({
      items: [group({ members: 1, openMembers: 1, title: "ISS-41 shipped but never closed — Invoicing", issueId: "i1" })],
      totalCount: 1,
    });
    open();
    await loaded();
    expect(screen.queryByText("The step that owed the close did not write it.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What this means" }));
    expect(screen.getByText("The step that owed the close did not write it.")).toBeInTheDocument();
  });

  it("names a failed load of its members, with a way to try again", async () => {
    server.ask = async () => ({ items: [group()], totalCount: 1 });
    server.members = () => Promise.reject(new Error("down"));
    open();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "2 of 3 still open — show" }));
    expect(await screen.findByText(/Couldn't load these\./)).toBeInTheDocument();
  });
});

describe("a row that has resolved", () => {
  it("carries no `new` badge though nobody has read it, since the server says nothing is left to read", async () => {
    server.ask = async () => ({
      items: [
        row(1, { title: "Resolved — ISS-5 is wedged", resolvedNotice: true, unread: false, readAt: null }),
        row(2, { title: "ISS-6 is wedged", unread: true }),
      ],
      totalCount: 2,
    });
    open();
    await loaded();
    expect(screen.getAllByText("new")).toHaveLength(1);
  });
});

describe("the filters", () => {
  it("ask the server for unread only, and for one type, before any page is cut", async () => {
    const seen: InboxFilter[] = [];
    server.ask = async (_page, filter) => {
      seen.push(filter as InboxFilter);
      return { items: [row(1)], totalCount: 1 };
    };
    open();
    await loaded();
    expect(seen).toEqual([{ type: null, unreadOnly: false }]);

    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    await waitFor(() => expect(seen.at(-1)).toEqual({ type: null, unreadOnly: true }));
    expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "issue_stranded" } });
    await waitFor(() => expect(seen.at(-1)).toEqual({ type: "issue_stranded", unreadOnly: true }));
  });

  it("count and page only the matches, and say so when none match", async () => {
    server.ask = async (_page, filter) =>
      (filter as InboxFilter).type === "ops_alert"
        ? { items: [], totalCount: 0 }
        : { items: [row(1), row(2)], totalCount: 2 };
    open();
    await loaded();
    expect(screen.getByText("2 notifications")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Type" }), { target: { value: "ops_alert" } });
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    expect(screen.queryByRole("feed")).toBeNull();
    expect(screen.queryByText("All caught up")).toBeNull();
  });

  it("offer every type there is, each named", async () => {
    serving(1);
    open();
    await loaded();
    const options = within(screen.getByRole("combobox", { name: "Type" })).getAllByRole("option");
    expect(options[0]).toHaveTextContent("All types");
    expect(options).toHaveLength(12);
    expect(options.every((o) => (o.textContent ?? "").trim().length > 0)).toBe(true);
  });

  it("keep every control at least 44px tall", async () => {
    serving(1);
    open();
    await loaded();
    for (const name of ["All", "Unread", "Mark all read"]) {
      expect(screen.getByRole("button", { name }).className).toContain("min-h-11");
    }
    expect(screen.getByRole("combobox", { name: "Type" }).className).toContain("min-h-11");
  });
});
