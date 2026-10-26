// @vitest-environment jsdom
//
// ISS-1229 r35, judge-95: reloading an open room landed on the "Start a conversation" chooser, because the
// address never carried the room. The address names the open room, and a reload opens it again — an
// archived one too, whose list is not the one shown by default.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const live = { id: "r1", projectId: "p1", title: "Desk triage", updatedAt: "2026-10-22T02:00:00Z", archivedAt: null };
const archived = {
  id: "r9",
  projectId: "p1",
  title: "Old close",
  updatedAt: "2026-10-01T02:00:00Z",
  archivedAt: "2026-10-02T02:00:00Z",
};

const desk = { id: "p1", name: "Desk", slug: "desk", orgId: "o1", role: "member" };
/** Ids of rooms no list holds, each one core's room door takes. */
const OLD = "5d0c1a7e-0000-4000-8000-0000000000a1";
const GONE = "5d0c1a7e-0000-4000-8000-0000000000a2";
const FLAKY = "5d0c1a7e-0000-4000-8000-0000000000a3";
const ORPHAN = "5d0c1a7e-0000-4000-8000-0000000000a4";
/** What the room's own read answers for an id no list holds (ISS-1229 r45). */
const roomRead = vi.hoisted(() => ({
  answers: {} as Record<string, { data?: unknown; error?: unknown }>,
  asked: [] as string[],
  refetched: 0,
}));
const reader = { role: "member", loading: false, unread: null as unknown, reads: 0 };
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ ...desk, role: reader.role }], isLoading: false }),
  useOrgScopedProjects: () => {
    const refetch = () => {
      reader.reads += 1;
    };
    if (reader.unread) return { projects: [], projectIds: new Set(), isLoading: false, error: reader.unread, refetch };
    return reader.role === "none"
      ? { projects: [], projectIds: new Set(), isLoading: reader.loading, error: null, refetch }
      : {
          projects: [{ ...desk, role: reader.role }],
          projectIds: new Set(["p1"]),
          isLoading: reader.loading,
          error: null,
          refetch,
        };
  },
}));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrgId: "o1" }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("../hooks", () => ({
  useConversationsAcrossProjects: (_ids: string[], showArchived: boolean) => ({
    rows: showArchived ? [archived] : [live],
    isLoading: false,
    error: null,
    refetch: () => {},
  }),
  useConversation: (id: string | undefined) => {
    if (id) roomRead.asked.push(id);
    const answer = id ? roomRead.answers[id] : undefined;
    return {
      data: answer?.data,
      error: answer?.error ?? null,
      isError: answer?.error !== undefined,
      isLoading: id !== undefined && answer === undefined,
      refetch: () => {
        roomRead.refetched += 1;
      },
    };
  },
  useArchiveConversation: () => ({ mutate: () => {} }),
  useDeleteConversation: () => ({ mutate: () => {} }),
  useRenameConversation: () => ({ mutate: () => {} }),
}));
vi.mock("./conversation-chat", () => ({
  ConversationChat: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="open-room">{conversationId ?? "draft"}</div>
  ),
}));
vi.mock("./conversation-sidebar", () => ({
  ConversationSidebar: ({
    rows,
    onOpen,
    onNew,
    onToggleArchived,
    below,
    error,
    onRetry,
  }: {
    rows: Array<{ id: string; title: string }>;
    onOpen: (row: unknown) => void;
    onNew?: () => void;
    onToggleArchived: () => void;
    below?: ReactNode;
    error?: unknown;
    onRetry?: () => void;
  }) => (
    <ul>
      {error != null && (
        <li>
          <button type="button" onClick={onRetry}>
            Read the list again
          </button>
        </li>
      )}
      {below && <li>{below}</li>}
      {onNew && (
        <li>
          <button type="button" onClick={onNew}>
            New conversation
          </button>
        </li>
      )}
      <li>
        <button type="button" onClick={onToggleArchived}>
          Switch list
        </button>
      </li>
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" onClick={() => onOpen(row)}>
            {row.title}
          </button>
        </li>
      ))}
    </ul>
  ),
}));
vi.mock("./orphan-rooms", () => ({ RoomsWithoutAProject: () => <div data-testid="orphan-section" /> }));
vi.mock("./orphan-room-view", () => ({ OrphanRoomView: () => null }));
vi.mock("./start-conversation", () => ({
  StartConversation: () =>
    reader.unread ? <h1>Couldn&apos;t load your projects</h1> : <div data-testid="chooser" />,
}));

const { ConversationsScreen } = await import("./conversations-screen");
const { ApiError } = await import("@/lib/api/client");

beforeEach(() => {
  reader.role = "member";
  reader.loading = false;
  reader.unread = null;
  reader.reads = 0;
  roomRead.answers = {};
  roomRead.asked = [];
  roomRead.refetched = 0;
  window.matchMedia = ((query: string) => ({
    matches: query === "(min-width: 768px)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const at = (path: string) => window.history.replaceState(null, "", path);

describe("the open room, across a reload", () => {
  it("is named in the address when opened, and open again after a reload", () => {
    at("/conversations");
    render(<ConversationsScreen />);
    expect(screen.getByTestId("chooser")).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Desk triage" })[0] as HTMLElement);
    });
    expect(window.location.search).toBe("?room=r1");

    cleanup();
    render(<ConversationsScreen />);
    expect(screen.getByTestId("open-room").textContent).toBe("r1");
  });

  it("opens an archived room the address names, from the archived list", () => {
    at("/conversations?room=r9&archived=1");
    render(<ConversationsScreen />);
    expect(screen.getByTestId("open-room").textContent).toBe("r9");
    expect(window.location.search).toBe("?room=r9&archived=1");
  });

  it("opens an archived room no list holds from its own read, though the address does not mark it archived", () => {
    roomRead.answers[OLD] = { data: { id: OLD, scope: ["p1"], archivedAt: "2026-09-01T00:00:00Z" } };
    at(`/conversations?room=${OLD}`);
    render(<ConversationsScreen />);
    expect(screen.getByTestId("open-room").textContent).toBe(OLD);
    expect(window.location.search).toBe(`?room=${OLD}&archived=1`);
  });

  it("keeps an open room's own list in the address when the other list is shown", () => {
    const pressFirst = (name: string) =>
      act(() => {
        fireEvent.click(screen.getAllByRole("button", { name })[0] as HTMLElement);
      });
    at("/conversations?room=r9&archived=1");
    render(<ConversationsScreen />);
    pressFirst("Switch list");
    expect(window.location.search).toBe("?room=r9&archived=1");
    cleanup();
    render(<ConversationsScreen />);
    expect(screen.getByTestId("open-room").textContent).toBe("r9");

    cleanup();
    at("/conversations");
    render(<ConversationsScreen />);
    pressFirst("Desk triage");
    pressFirst("Switch list");
    expect(window.location.search).toBe("?room=r1");
    cleanup();
    render(<ConversationsScreen />);
    expect(screen.getByTestId("open-room").textContent).toBe("r1");
  });
});

// ISS-1229 r35, judge-95: the list offered a viewer a room they could not start.
describe("the offer of a new room", () => {
  it("is made to a member of a project here", () => {
    at("/conversations");
    render(<ConversationsScreen />);
    expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy();
  });

  it("is not made while the reader's projects are still being read", () => {
    reader.loading = true;
    at("/conversations");
    render(<ConversationsScreen />);
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  });

  it("is not made to a reader who can see no project here", () => {
    reader.role = "none";
    at("/conversations");
    render(<ConversationsScreen />);
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  });

  it("is not made to a reader holding only the viewer role here", () => {
    reader.role = "viewer";
    at("/conversations");
    render(<ConversationsScreen />);
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  });
});

// ISS-1229 r45, judge-129: an address naming a room that does not exist opened the chooser, kept the dead
// id and titled the tab "Forge"; the person who followed the link was never told.
describe("an address naming a room the reader cannot open", () => {
  for (const [why, status, code] of [
    ["was deleted", 404, "NOT_FOUND"],
    ["is a one-to-one room they are not in", 403, "NOT_IN_THE_ROOM"],
  ] as const) {
    it(`says the conversation was not found where the room ${why}, in the heading and the tab`, () => {
      roomRead.answers[GONE] = { error: new ApiError(status, "This room no longer exists.", code) };
      at(`/conversations?room=${GONE}`);
      render(<ConversationsScreen />);
      expect(screen.getByRole("heading", { level: 1, name: "Conversation not found" })).toBeTruthy();
      expect(document.title).toBe("Conversation not found · Forge");
      expect(screen.queryByTestId("chooser")).toBeNull();
      expect(window.location.search).toBe(`?room=${GONE}`);
    });
  }

  // ISS-1229 r46, judge-135: a link cut short or mistyped read "Couldn't load this conversation / The field
  // id is not a valid UUID." with a Retry that could never succeed.
  for (const [why, id] of [
    ["was cut short when copied", "b4375f4f-9f59-47a1-b108-ef9f72"],
    ["was mistyped", "not-a-room-id"],
  ] as const) {
    it(`says the conversation was not found where the room's id ${why}, without reading it`, () => {
      roomRead.answers[id] = { error: new ApiError(400, "The field id is not a valid UUID.") };
      at(`/conversations?room=${id}`);
      render(<ConversationsScreen />);
      expect(screen.getByRole("heading", { level: 1, name: "Conversation not found" })).toBeTruthy();
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(document.title).toBe("Conversation not found · Forge");
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(screen.queryByText(/valid UUID/)).toBeNull();
      expect(roomRead.asked).not.toContain(id);
      expect(window.location.search).toBe(`?room=${id}`);
    });
  }

  it("heads a phone's page with the not-found state alone, never beside the page's own title", () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    roomRead.answers[GONE] = { error: new ApiError(404, "This room no longer exists.") };
    at(`/conversations?room=${GONE}`);
    render(<ConversationsScreen />);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Conversation not found",
    ]);
  });

  // ISS-1229 r47 (cef47c6a, routed from ISS-1421 r33): a person whose role on the room's project was taken
  // away read "Conversation not found. It was deleted, or you are not one of its people", both untrue.
  const NO_ROLE =
    "You hold no role on a project this room is about, so you cannot read this room. An admin of that project can add you to it.";
  for (const [who, role] of [
    ["whose role on its project was taken away", "member"],
    ["whose organization holds no project of theirs", "none"],
  ] as const) {
    it(`tells a reader ${who} that they have no access to it and who can add them, never that it was not found`, () => {
      reader.role = role;
      roomRead.answers[GONE] = { error: new ApiError(403, NO_ROLE, "CONVERSATION_OUT_OF_SCOPE") };
      at(`/conversations?room=${GONE}`);
      render(<ConversationsScreen />);
      expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
        "No access to this conversation",
      ]);
      expect(screen.getByText(NO_ROLE)).toBeTruthy();
      expect(document.title).toBe("No access to this conversation · Forge");
      expect(screen.queryByText(/Conversation not found|It was deleted|one of its people/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      expect(window.location.search).toBe(`?room=${GONE}`);
    });
  }

  it("lets go of the address once the reader starts a new conversation", () => {
    roomRead.answers[GONE] = { error: new ApiError(404, "This room no longer exists.") };
    at(`/conversations?room=${GONE}`);
    render(<ConversationsScreen />);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    });
    expect(screen.getByTestId("chooser")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("offers a retry where the room could not be read, and never says it was not found", () => {
    roomRead.answers[FLAKY] = { error: new ApiError(503, "Service unavailable") };
    at(`/conversations?room=${FLAKY}`);
    render(<ConversationsScreen />);
    expect(screen.getByRole("heading", { level: 1, name: "Couldn't load this conversation" })).toBeTruthy();
    expect(screen.queryByText("Conversation not found")).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(roomRead.refetched).toBe(1);
  });

  it("says where a room about no project is opened from, and shows the list that holds it", () => {
    roomRead.answers[ORPHAN] = { data: { id: ORPHAN, scope: [], archivedAt: null } };
    at(`/conversations?room=${ORPHAN}&archived=1`);
    render(<ConversationsScreen />);
    expect(screen.getByRole("heading", { level: 1, name: "This conversation is about no project" })).toBeTruthy();
    expect(screen.getByText(/Open it from Project deleted, .* in the organization it belonged to/)).toBeTruthy();
    expect(screen.getByTestId("orphan-section")).toBeTruthy();
  });
});

// ISS-1229 r47, judge-137: with the projects read failing, the pane said "No project you can see" and the list
// "No conversations yet", with no Retry and the tab "Forge".
describe("the page when the reader's projects cannot be read", () => {
  it("hands the list that failure and its Retry, and lets the pane's state head the page alone", () => {
    reader.unread = new ApiError(500, "The server ran into a problem.");
    at("/conversations");
    render(<ConversationsScreen />);
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Couldn't load your projects",
    ]);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Read the list again" }));
    });
    expect(reader.reads).toBe(1);
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
  });
});
