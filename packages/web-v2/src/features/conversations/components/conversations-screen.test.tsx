// @vitest-environment jsdom
//
// ISS-1229 r35, judge-95: reloading an open room landed on the "Start a conversation" chooser, because the
// address never carried the room. The address names the open room, and a reload opens it again — an
// archived one too, whose list is not the one shown by default.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const live = { id: "r1", projectId: "p1", title: "Desk triage", updatedAt: "2026-10-22T02:00:00Z" };
const archived = { id: "r9", projectId: "p1", title: "Old close", updatedAt: "2026-10-01T02:00:00Z" };

vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Desk", slug: "desk", orgId: "o1" }], isLoading: false }),
  useOrgScopedProjects: () => ({
    projects: [{ id: "p1", name: "Desk", slug: "desk", orgId: "o1" }],
    projectIds: new Set(["p1"]),
  }),
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
  }: {
    rows: Array<{ id: string; title: string }>;
    onOpen: (row: unknown) => void;
  }) => (
    <ul>
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
vi.mock("./orphan-rooms", () => ({ RoomsWithoutAProject: () => null }));
vi.mock("./orphan-room-view", () => ({ OrphanRoomView: () => null }));
vi.mock("./start-conversation", () => ({ StartConversation: () => <div data-testid="chooser" /> }));

const { ConversationsScreen } = await import("./conversations-screen");

beforeEach(() => {
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

  it("shows the chooser for a room the address names that no list holds, and drops it from the address", () => {
    at("/conversations?room=gone");
    render(<ConversationsScreen />);
    expect(screen.getByTestId("chooser")).toBeTruthy();
    expect(window.location.search).toBe("");
  });
});
