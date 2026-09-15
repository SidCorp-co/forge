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

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("./api", () => ({ conversationsApi: { list: (...a: unknown[]) => list(...a) } }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { useConversationsAcrossProjects } = await import("./hooks");

const room = (id: string, updatedAt: string, title: string) => ({
  id,
  adapter: "web",
  externalId: `v-${id}`,
  shape: "group",
  title,
  updatedAt,
});

function mount(projectIds: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useConversationsAcrossProjects(projectIds), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
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

  // cm:guard the kept row carries a project the room really is about, because the selection is built from it — a row keyed to a project the caller holds no role on would open a room the server then refuses, which reads as a broken list rather than as a rule.
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
