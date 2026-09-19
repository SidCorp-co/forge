// @vitest-environment jsdom
//
// ISS-1011 follow-up — a room is listed once, however many projects it is about.
//
// The cross-project list fans out one read per project and concatenates what
// comes back. That was exact while a room could only ever hold one agent, and
// so could only be about one project. Since a room's membership became
// changeable it can be about two, both reads return it, and the list printed it
// twice: same title, same timestamp, differing only by the project line under
// it. Two rows that open the same room read as two rooms.
//
// ISS-1040 — and the same fan-out answers for the ARCHIVED set as well as the
// live one. It used to take no `archived` argument at all and hard-code the
// trailing `"live"` key segment, so a room archived from `/conversations` could
// be neither listed nor unarchived there. What the archived side owes on top of
// working at all: the SAME request and the SAME key expression the per-project
// `useConversations` builds, so the live key stays the one the dock shares
// (ISS-1028's two disjoint cache keys), and the one-row-per-room dedupe above.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
const detail = vi.fn();
vi.mock("./api", () => ({
  conversationsApi: {
    list: (...a: unknown[]) => list(...a),
    detail: (...a: unknown[]) => detail(...a),
  },
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { useConversation, useConversations, useConversationsAcrossProjects } = await import(
  "./hooks"
);

const room = (id: string, updatedAt: string, title: string, archivedAt: string | null = null) => ({
  id,
  adapter: "web",
  externalId: `v-${id}`,
  shape: "group", mode: null,
  title,
  updatedAt,
  archivedAt,
});

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function mountOn(qc: QueryClient, projectIds: string[], archived: boolean) {
  return renderHook(() => useConversationsAcrossProjects(projectIds, archived), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
}

/** The hook as every caller wrote it before ISS-1040 — one argument, no side named. */
function mount(projectIds: string[]) {
  const qc = newClient();
  return renderHook(() => useConversationsAcrossProjects(projectIds), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
}

const keysIn = (qc: QueryClient) => qc.getQueryCache().getAll().map((q) => q.queryKey);

/** Both readers of the same project's same side, alive in one cache at once. */
function mountPaired(qc: QueryClient, projectId: string, archived: boolean) {
  return renderHook(
    () => ({
      perProject: useConversations(projectId, archived),
      acrossProjects: useConversationsAcrossProjects([projectId], archived),
    }),
    {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    },
  );
}

describe("the rooms of every project, in one list", () => {
  it("lists a room about two projects ONCE, not once per project", async () => {
    list.mockImplementation(async (projectId: string) => ({
      items:
        projectId === "p1"
          ? [room("shared", "2026-09-15T10:00:00.000Z", "About both")]
          : [
              room("shared", "2026-09-15T10:00:00.000Z", "About both"),
              room("only-b", "2026-09-15T09:00:00.000Z", "About B alone"),
            ],
      total: 1,
    }));

    const { result } = mount(["p1", "p2"]);
    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const ids = result.current.rows.map((r) => r.id);
    expect(ids.filter((id) => id === "shared")).toHaveLength(1);
    expect(ids).toContain("only-b");
  });

  it("keeps a real project for the room it kept", async () => {
    list.mockImplementation(async (projectId: string) => ({
      items: [room("shared", "2026-09-15T10:00:00.000Z", "About both")],
      total: 1,
      _p: projectId,
    }));
    const { result } = mount(["p1", "p2"]);
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(["p1", "p2"]).toContain(result.current.rows[0]?.projectId);
  });

  it("still lists every distinct room across the projects", async () => {
    list.mockImplementation(async (projectId: string) => ({
      items: [room(`room-${projectId}`, "2026-09-15T10:00:00.000Z", projectId)],
      total: 1,
    }));
    const { result } = mount(["p1", "p2", "p3"]);
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((r) => r.id).sort()).toEqual([
      "room-p1",
      "room-p2",
      "room-p3",
    ]);
  });
});

describe("the archived rooms of every project, in the same list", () => {
  const bothSides = (liveIds: string[], archivedIds: string[]) =>
    list.mockImplementation(async (_projectId: string, _pageSize: number, wantArchived: boolean) => {
      const ids = wantArchived ? archivedIds : liveIds;
      return {
        items: ids.map((id, i) => room(id, `2026-09-1${5 - i}T10:00:00.000Z`, id, wantArchived ? "2026-09-10T00:00:00.000Z" : null)),
        total: ids.length,
      };
    });

  it("asks for the archived side of every project, at the page size the per-project list uses", async () => {
    bothSides(["live-1"], ["arch-1"]);
    const { result } = mountOn(newClient(), ["p1", "p2"], true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(list).toHaveBeenCalledWith("p1", 50, true);
    expect(list).toHaveBeenCalledWith("p2", 50, true);
    expect(result.current.rows.map((r) => r.id)).toEqual(["arch-1"]);
  });

  it("asks for the live side, at that same page size, when it is not asked for the archived one", async () => {
    bothSides(["live-1"], ["arch-1"]);
    const { result } = mountOn(newClient(), ["p1"], false);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(list).toHaveBeenCalledWith("p1", 50, false);
    expect(list).not.toHaveBeenCalledWith("p1", 50, true);
    expect(result.current.rows.map((r) => r.id)).toEqual(["live-1"]);
  });

  it("caches the archived side under the trailing `archived` segment and the live side under `live`", async () => {
    bothSides(["live-1"], ["arch-1"]);
    const qc = newClient();
    const liveView = mountOn(qc, ["p1"], false);
    await waitFor(() => expect(liveView.result.current.isLoading).toBe(false));
    const archivedView = mountOn(qc, ["p1"], true);
    await waitFor(() => expect(archivedView.result.current.isLoading).toBe(false));

    expect(keysIn(qc)).toContainEqual(["conversations", "list", "p1", "live"]);
    expect(keysIn(qc)).toContainEqual(["conversations", "list", "p1", "archived"]);
  });

  it("keeps the two sets apart in one cache rather than serving one list filtered", async () => {
    bothSides(["live-1"], ["arch-1"]);
    const qc = newClient();
    const liveView = mountOn(qc, ["p1"], false);
    await waitFor(() => expect(liveView.result.current.isLoading).toBe(false));
    const archivedView = mountOn(qc, ["p1"], true);
    await waitFor(() => expect(archivedView.result.current.isLoading).toBe(false));

    const cached = (key: unknown[]) =>
      qc.getQueryData(key) as { items: Array<{ id: string }> } | undefined;
    expect(cached(["conversations", "list", "p1", "live"])?.items.map((r) => r.id)).toEqual([
      "live-1",
    ]);
    expect(cached(["conversations", "list", "p1", "archived"])?.items.map((r) => r.id)).toEqual([
      "arch-1",
    ]);
    expect(liveView.result.current.rows.map((r) => r.id)).toEqual(["live-1"]);
    expect(archivedView.result.current.rows.map((r) => r.id)).toEqual(["arch-1"]);
  });

  it("lists an archived room about two projects ONCE, not once per project", async () => {
    list.mockImplementation(async (projectId: string, _pageSize: number, wantArchived: boolean) => {
      if (!wantArchived) return { items: [], total: 0 };
      return {
        items:
          projectId === "p1"
            ? [room("shared", "2026-09-15T10:00:00.000Z", "Filed by both", "2026-09-10T00:00:00.000Z")]
            : [
                room("shared", "2026-09-15T10:00:00.000Z", "Filed by both", "2026-09-10T00:00:00.000Z"),
                room("only-b", "2026-09-15T09:00:00.000Z", "Filed by B alone", "2026-09-10T00:00:00.000Z"),
              ],
        total: 1,
      };
    });

    const { result } = mountOn(newClient(), ["p1", "p2"], true);
    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const ids = result.current.rows.map((r) => r.id);
    expect(ids.filter((id) => id === "shared")).toHaveLength(1);
    expect(ids).toContain("only-b");
  });
});

describe("the fan-out and the per-project reader are ONE read, per project per side", () => {
  const bothSidesFor = () =>
    list.mockImplementation(async (_projectId: string, _pageSize: number, wantArchived: boolean) => ({
      items: [
        room(
          wantArchived ? "arch-1" : "live-1",
          "2026-09-15T10:00:00.000Z",
          wantArchived ? "Filed away" : "In play",
          wantArchived ? "2026-09-10T00:00:00.000Z" : null,
        ),
      ],
      total: 1,
    }));

  for (const [side, archived, segment] of [
    ["archived", true, "archived"],
    ["live", false, "live"],
  ] as const) {
    it(`shares one cache entry and one request on the ${side} side`, async () => {
      bothSidesFor();
      const qc = newClient();
      const { result } = mountPaired(qc, "p1", archived);
      await waitFor(() => expect(result.current.perProject.isLoading).toBe(false));
      await waitFor(() => expect(result.current.acrossProjects.isLoading).toBe(false));

      expect(keysIn(qc)).toEqual([["conversations", "list", "p1", segment]]);
      expect(list.mock.calls).toEqual([["p1", 50, archived]]);
      expect(result.current.acrossProjects.rows.map((r) => r.id)).toEqual(
        result.current.perProject.data?.items.map((r) => r.id),
      );
    });
  }
});

describe("useConversation \u00b7 watching an Agent turn move", () => {
  const roomWith = (turns: Array<{ state: string }>) => ({
    id: "c1",
    adapter: "web",
    externalId: "v1",
    shape: "direct",
    mode: "agent",
    title: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    scope: ["p1"],
    participants: [],
    messages: [],
    windows: [],
    agentMode: { available: true, reason: null },
    agentTurns: turns.map((t, i) => ({
      windowId: `w${i}`,
      sessionId: `s${i}`,
      reason: null,
      ...t,
    })),
  });

  function mountRoom(qc: QueryClient) {
    return renderHook(() => useConversation("c1"), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      ),
    });
  }

  it("re-reads the room while a turn is dispatched or running, and shows what changed", async () => {
    vi.useFakeTimers();
    try {
      detail.mockReset();
      detail
        .mockResolvedValueOnce(roomWith([{ state: "dispatched" }]))
        .mockResolvedValueOnce(roomWith([{ state: "running" }]))
        .mockResolvedValue(roomWith([{ state: "delivered" }]));

      const { result } = mountRoom(newClient());
      await vi.waitFor(() => expect(result.current.data?.agentTurns?.[0]?.state).toBe("dispatched"));

      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(result.current.data?.agentTurns?.[0]?.state).toBe("running"));

      await vi.advanceTimersByTimeAsync(4000);
      await vi.waitFor(() => expect(result.current.data?.agentTurns?.[0]?.state).toBe("delivered"));

      const settled = detail.mock.calls.length;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(detail.mock.calls.length).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never polls a room that holds no live turn", async () => {
    vi.useFakeTimers();
    try {
      detail.mockReset();
      detail.mockResolvedValue(roomWith([]));

      const { result } = mountRoom(newClient());
      await vi.waitFor(() => expect(result.current.data?.id).toBe("c1"));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(detail).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
