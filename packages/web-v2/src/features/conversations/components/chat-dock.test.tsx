// ISS-277 (FB-88): the dock opened with nothing picked (a reload, a new tab, a project switch) lands
// on the project's latest conversation, the one waiting on the person first, and a conversation
// waiting on the person is one click away from any other. A failed read says so; it never quietly
// opens a new chat in the conversation's place.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatDockApi } from "@/features/chat-dock/dock";
import { type ChatTarget, targetInScope } from "@/features/chat-dock/dock-target";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ChatDockBody } from "./chat-dock";

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/epod/requirements" }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("./conversation-chat", () => ({
  ConversationChat: ({ conversationId }: { conversationId?: string }) => (
    <div data-testid="chat" data-conversation={conversationId ?? "new"} />
  ),
}));

afterEach(() => vi.unstubAllGlobals());

const project = { id: "p1", name: "epod", slug: "epod" };

function row(id: string, title: string, threadStatus: string, minute: number) {
  return {
    id,
    adapter: "web",
    externalId: id,
    shape: "direct",
    mode: "assistant",
    title,
    updatedAt: `2026-10-06T16:${minute}:00Z`,
    archivedAt: null,
    ecosystemId: null,
    kind: null as string | null,
    threadStatus,
    subjectKey: null as string | null,
  };
}

type Room = ReturnType<typeof row>;

const drafted = row("c-req1", "Draft REQ-1", "waiting_on_you", 51);
const later = row("c-other", "Something else", "done", 53);

function core(rooms: Room[] | "refused") {
  return fakeCore(({ path }) => {
    if (path === "/projects") return { body: [project] };
    if (path.startsWith("/conversations?")) {
      return rooms === "refused" ? { status: 500, body: { error: { message: "list read failed" } } } : { body: { items: rooms, total: rooms.length } };
    }
    if (path.startsWith("/conversations/")) {
      const id = path.split("/")[2];
      const listed = rooms === "refused" ? undefined : (rooms as Room[]).find((r) => r.id === id);
      return { body: { id, subjectKey: listed?.subjectKey ?? null, kind: listed?.kind ?? null, ecosystemId: null } };
    }
    return undefined;
  });
}

function dockOn(target: ChatTarget | null): ChatDockApi {
  return {
    projectId: "p1",
    open: true,
    pinned: false,
    setPinned: vi.fn(),
    target,
    generation: 0,
    width: 400,
    setWidth: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    toggle: vi.fn(),
    select: vi.fn(),
    follow: vi.fn(),
    askAbout: vi.fn(),
    setDoor: vi.fn(),
  };
}

describe("the dock opened with nothing picked", () => {
  it("lands on the conversation waiting on the person, not a new chat", async () => {
    core([later, drafted]);
    const dock = dockOn(targetInScope(null, "p1"));
    renderWithQuery(<ChatDockBody dock={dock} />);
    await waitFor(() =>
      expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-req1" }),
    );
    expect(screen.queryByTestId("chat")).toBeNull();
  });

  it("opens a new draft only when the project has no conversation", async () => {
    core([]);
    const dock = dockOn(targetInScope(null, "p1"));
    renderWithQuery(<ChatDockBody dock={dock} />);
    await waitFor(() => expect(dock.select).toHaveBeenCalledWith({ kind: "draft", projectId: "p1" }));
  });

  it("says the list could not be read, with a retry, and opens nothing in its place", async () => {
    core("refused");
    const dock = dockOn(targetInScope(null, "p1"));
    renderWithQuery(<ChatDockBody dock={dock} />);
    expect(await screen.findByText("Conversations could not be read")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(dock.select).not.toHaveBeenCalled();
  });
});

describe("a conversation waiting on the person", () => {
  it("is offered by name over a new draft, and one click opens it", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "draft", projectId: "p1" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Draft REQ-1, waiting on you" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-req1" });
  });

  it("is offered by name over another open conversation, and one click opens it", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-other" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    expect((await screen.findByTestId("chat")).getAttribute("data-conversation")).toBe("c-other");
    fireEvent.click(await screen.findByRole("button", { name: "Open Draft REQ-1, waiting on you" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-req1" });
  });

  it("is not offered while it is the conversation open", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-req1" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    expect(await screen.findByTestId("chat")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /waiting on you/ })).toBeNull();
  });

  it("still lets New conversation start a fresh draft", async () => {
    core([later, drafted]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-other" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "draft", projectId: "p1" });
  });
});

// FB-100: on the Dashboard, Ask Agent reopened the REQ-17 room, which reads only REQ-17; a whole-
// project question asked there was refused after 20 s, and nothing on the panel said why
describe("a room scoped to a record", () => {
  const req17: Room = { ...row("c-req17", "REQ-17 export", "done", 55), kind: "requirement", subjectKey: "REQ-17" };

  it("is not reopened off its record's page when it is not waiting on the person", async () => {
    core([later, req17]);
    const dock = dockOn(targetInScope(null, "p1"));
    renderWithQuery(<ChatDockBody dock={dock} />);
    await waitFor(() =>
      expect(dock.select).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "c-other" }),
    );
  });

  it("names its scope and what its agent cannot read, and offers the whole project in one click", async () => {
    core([later, req17]);
    const dock = dockOn({ kind: "room", projectId: "p1", conversationId: "c-req17" });
    renderWithQuery(<ChatDockBody dock={dock} />);
    const note = await screen.findByTestId("subject-scope-notice");
    expect(note.textContent).toContain(
      "This conversation is about REQ-17. Its agent reads REQ-17, the issues you name and similar requirements; it cannot read the rest of the project.",
    );
    fireEvent.click(screen.getByRole("button", { name: "New conversation about the whole project" }));
    expect(dock.select).toHaveBeenCalledWith({ kind: "draft", projectId: "p1" });
  });

  it("names a first-requirements room's scope too, and says nothing over a project room", async () => {
    const first: Room = { ...row("c-first", "First requirements", "done", 56), kind: "first_requirements" };
    core([later, first]);
    const { unmount } = renderWithQuery(
      <ChatDockBody dock={dockOn({ kind: "room", projectId: "p1", conversationId: "c-first" })} />,
    );
    expect((await screen.findByTestId("subject-scope-notice")).textContent).toContain("drafts the first requirements");
    unmount();
    renderWithQuery(<ChatDockBody dock={dockOn({ kind: "room", projectId: "p1", conversationId: "c-other" })} />);
    expect(await screen.findByTestId("chat")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("subject-scope-notice")).toBeNull();
  });
});
