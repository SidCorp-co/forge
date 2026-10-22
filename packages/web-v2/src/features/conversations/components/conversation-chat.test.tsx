// @vitest-environment jsdom
//
// ISS-1146 — the wiring this pane owns: the staged file reaches the room
// before the message that cites it, the composer says which mode the room is
// in, and the header no longer tells an Agent room it cannot see a repository.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { ConversationDetail } from "../types";

expect.extend(matchers);
afterEach(cleanup);

// jsdom lays nothing out, so the thread's stick-to-bottom has no element to
// scroll to. Supplying the method is what the other suites in this package do.
Element.prototype.scrollIntoView = vi.fn();

interface SendArgs {
  conversationId: string;
  content: string;
  attachmentIds?: string[];
}
const send = vi.fn(async (_args: SendArgs) => undefined);
const uploadOne = vi.fn(async ({ file }: { file: File }) => ({ id: `att-${file.name}` }));
const stop = vi.fn();
const openRoom = vi.fn(async (_args: { projectId: string }) => ({ id: "c9" }));
let room: ConversationDetail | undefined;
let progress: { entry: string; replaced?: boolean } | null = null;
let sendPending = false;
let roomError: unknown = null;
const toast = vi.fn();

function detail(over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: "c1",
    adapter: "web",
    externalId: "web c1",
    shape: "direct",
    mode: null,
    title: null,
    updatedAt: "2026-09-21T10:00:00.000Z",
    archivedAt: null,
    messages: [],
    windows: [],
    agentTurns: [],
    agentMode: { available: true, reason: null },
    participants: [],
    scope: [],
    scopeProjects: [],
    canChangeMembership: true,
    ...over,
  };
}

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

let projectRole = "admin";
/** The reader's other projects, beside Desk, with the role they hold on each (r35). */
let otherProjects: Array<{ id: string; name: string; role: string }> = [];
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Desk", role: projectRole }, ...otherProjects] }),
}));

vi.mock("./conversation-members", () => ({ ConversationMembers: () => null }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

vi.mock("../hooks", () => ({
  useConversation: () =>
    roomError
      ? { data: undefined, isLoading: false, isError: true, isSuccess: false, error: roomError }
      : { data: room, isLoading: false, isError: false, isSuccess: true },
  useAcceptedMessages: () => ({}),
  useConversationProgress: () => progress,
  useWithdrawnDrafts: () => ({}),
  useDraftAgentMode: () => ({ data: { available: true, reason: null } }),
  useOpenConversation: () => ({ isPending: false, mutateAsync: openRoom }),
  useSendMessage: () => ({ isPending: sendPending, mutateAsync: send }),
  useUploadAttachment: () => ({ mutateAsync: uploadOne }),
  useStopConversation: () => ({ mutate: stop, isPending: false }),
  useRemoveParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useAddPerson: () => ({ mutate: vi.fn(), isPending: false }),
  useAddHandle: () => ({ mutate: vi.fn(), isPending: false }),
  useConversationCandidates: () => ({ data: undefined }),
}));

const { ConversationChat } = await import("./conversation-chat");

beforeEach(() => {
  send.mockClear();
  uploadOne.mockClear();
  stop.mockClear();
  openRoom.mockClear();
  room = detail();
  progress = null;
  sendPending = false;
  roomError = null;
  projectRole = "admin";
  otherProjects = [];
  toast.mockClear();
});

function fileOf(name: string, type: string): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: 64 });
  return f;
}

function open(onRoomGone?: (id: string) => void) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationChat projectId="p1" conversationId="c1" {...(onRoomGone ? { onRoomGone } : {})} />
    </QueryClientProvider>,
  );
}

const roomGone = () =>
  new ApiError(404, "This room no longer exists.", "CONVERSATION_GONE", { conversationId: "c1" });

describe("the header", () => {
  it("no longer claims every room reads the project and not the repository", () => {
    open();
    expect(screen.queryByText(/reads the project, not the repository/)).not.toBeInTheDocument();
  });
});

describe("the composer this pane renders", () => {
  it("carries the mode control inside its own frame", () => {
    open();
    expect(screen.getByTestId("chat-composer")).toContainElement(
      screen.getByTestId("conversation-mode-toggle"),
    );
  });

  it("says which mode a settled room is in", () => {
    room = detail({ mode: "agent" });
    open();
    expect(screen.getByTestId("conversation-mode-settled")).toHaveTextContent("Agent");
  });

  it("names the mode in the box's own placeholder", () => {
    room = detail({ mode: "agent" });
    open();
    expect(screen.getByLabelText("Message")).toHaveAttribute(
      "placeholder",
      expect.stringContaining("Agent"),
    );
  });

  it("can take a file", () => {
    open();
    expect(screen.getByLabelText("Attach files")).toBeInTheDocument();
  });
});

describe("a message with a file on it", () => {
  it("puts the file in the room, then sends the id it became", async () => {
    open();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileOf("shot.png", "image/png")] } });
    await screen.findByText("shot.png");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "what is this" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(uploadOne).toHaveBeenCalledWith({
      conversationId: "c1",
      file: expect.objectContaining({ name: "shot.png" }),
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "c1",
      content: "what is this",
      attachmentIds: ["att-shot.png"],
    });
  });

  it("does not store the same picture twice when a failed send is retried", async () => {
    send.mockRejectedValueOnce(new Error("network"));
    open();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileOf("shot.png", "image/png")] } });
    await screen.findByText("shot.png");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "what is this" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(uploadOne).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByText("Try again"));

    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(uploadOne).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ attachmentIds: ["att-shot.png"] });
  });

  it("sends no attachmentIds at all where nothing was staged", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "plain question" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(uploadOne).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("attachmentIds");
  });
});

describe("stopping an answer", () => {
  it("offers no stop in a room that is answering nothing", () => {
    open();
    expect(screen.queryByLabelText("Stop answering")).not.toBeInTheDocument();
  });

  it("keeps Send until an answer is actually running, not while its own send is in flight", () => {
    // The window between this browser's send and the first progress the server
    // publishes: there is no turn to stop yet, whatever this mutation is doing.
    sendPending = true;
    progress = null;
    open();
    expect(screen.queryByLabelText("Stop answering")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeInTheDocument();
  });

  it("offers it to whoever is in the room, not only to whoever asked", () => {
    // This browser sent nothing: the answer is arriving over the socket.
    progress = { entry: "the agent is typing" };
    open();
    fireEvent.click(screen.getByLabelText("Stop answering"));
    expect(stop).toHaveBeenCalledWith("c1");
  });
});

// ISS-1229 r28, judge-80: another person deleted the open room, and Enter showed "Couldn't send.
// Conversation not found. Try again" — a retry that could only meet the same refusal — while the room
// stayed open and listed.
describe("a room deleted while it is open", () => {
  it("says it was deleted and the message was not sent, offers no Try again, and hands back to the list", async () => {
    send.mockRejectedValueOnce(roomGone());
    const backToList = vi.fn();
    open(backToList);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "are we still on?" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(backToList).toHaveBeenCalledWith("c1"));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "This room was deleted",
        description: expect.stringMatching(/your message was not sent/),
      }),
    );
    expect(screen.getByTestId("conversation-gone")).toHaveTextContent("This room was deleted");
    expect(screen.queryByText("Try again")).not.toBeInTheDocument();
    expect(screen.queryByText(/Conversation not found/)).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });

  // r29, judge-84: the typed message was kept nowhere once the room and its thread were gone.
  it("keeps the unsent message in the notice until the reader copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    send.mockRejectedValueOnce(roomGone());
    open(vi.fn());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "the numbers for Friday" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { description: string; keep: boolean; onClick: () => void };
    expect(notice.description).toContain("“the numbers for Friday”");
    expect(notice.keep).toBe(true);
    expect(notice).toMatchObject({ tone: "error" });
    notice.onClick();
    expect(writeText).toHaveBeenCalledWith("the numbers for Friday");
    // r31, judge-88: the word that it was copied replaced the notice in place, never a second toast that
    // landed over New conversation on a phone.
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    const copied = toast.mock.calls[1]?.[0] as { slot: string; description: string; keep: boolean; onClick: () => void };
    expect(copied).toMatchObject({ title: "This room was deleted", keep: true, slot: (notice as { slot?: string }).slot });
    expect(copied.slot).toEqual(expect.any(String));
    expect(copied.description).toMatch(/^What you wrote was copied\. Select this to copy it again:\n“the numbers for Friday”$/);
    copied.onClick();
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(toast.mock.calls.map((c) => (c[0] as { title: string }).title)).not.toContain("What you wrote was copied");
  });

  // r31 review F1: a per-mount count gave a second mount's notice the first one's slot, which replaced it.
  it("gives each kept notice its own slot, across mounts, and copies into that one", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    const notices: { slot: string; onClick: () => void }[] = [];
    for (const text of ["first draft", "second draft"]) {
      send.mockRejectedValueOnce(roomGone());
      const { unmount } = render(
        <QueryClientProvider client={new QueryClient()}>
          <ConversationChat projectId="p1" conversationId="c1" onRoomGone={vi.fn()} />
        </QueryClientProvider>,
      );
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
      fireEvent.click(screen.getByLabelText("Send message"));
      await waitFor(() => expect(toast).toHaveBeenCalledTimes(notices.length + 1));
      notices.push(toast.mock.calls[notices.length]?.[0] as { slot: string; onClick: () => void });
      unmount();
    }
    expect(new Set(notices.map((n) => n.slot)).size).toBe(2);
    notices[0]?.onClick();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(3));
    expect(toast.mock.calls[2]?.[0]).toMatchObject({ slot: notices[0]?.slot, description: expect.stringContaining("“first draft”") });
  });

  // r29 review F2: the deletion event's re-read found the room gone while a send was still out, and
  // the send's own refusal, arriving second, was swallowed with the text it carried.
  it("keeps a message still being sent when a re-read finds the room gone first", async () => {
    let reject: (err: unknown) => void = () => {};
    send.mockImplementationOnce(() => new Promise((_, no) => (reject = no)));
    const tree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" conversationId="c1" onRoomGone={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "the courier moved to 3 pm" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(send).toHaveBeenCalled());

    roomError = roomGone();
    rerender(tree());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "This room was deleted" })));
    reject(roomGone());

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ keep: true, description: expect.stringContaining("“the courier moved to 3 pm”") }),
      ),
    );
  });

  it("keeps a message still waiting its turn when a re-read finds the room gone", async () => {
    let reject: (err: unknown) => void = () => {};
    send.mockImplementationOnce(() => new Promise((_, no) => (reject = no)));
    const tree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" conversationId="c1" onRoomGone={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "first" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(send).toHaveBeenCalled());
    fireEvent.change(box, { target: { value: "second, still queued" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    roomError = roomGone();
    rerender(tree());
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ keep: true, description: expect.stringContaining("“second, still queued”") }),
      ),
    );
    // Send was pressed for it, so this one was not sent (r31).
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ keep: true, description: expect.stringMatching(/your message was not sent/) }),
    );
    reject(new Error("aborted"));
  });

  // r32, judge-90: a refused copy raised a second toast and left the notice saying "select it to copy",
  // so the next tap failed the same way. The notice itself turns into one to copy by hand.
  it("turns the notice into one to copy by hand when the browser refuses the copy", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const long = "x".repeat(260);
    send.mockRejectedValueOnce(roomGone());
    open(vi.fn());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: long } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { slot: string; description: string; onClick: () => void };
    expect(notice.description).toContain(`“${"x".repeat(200)}…”`);
    notice.onClick();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    const byHand = toast.mock.calls[1]?.[0] as { slot: string; title: string; description: string; keep: boolean; onClick?: unknown };
    expect(byHand).toMatchObject({ title: "This room was deleted", slot: notice.slot, keep: true });
    expect(byHand.description).toMatch(/^It could not be copied here\. Select the text below and copy it by hand:\n/);
    expect(byHand.description).toContain(`“${long}”`);
    expect(byHand.onClick).toBeUndefined();
    expect(byHand).toMatchObject({ verbatim: true });
    expect(toast.mock.calls.map((c) => (c[0] as { title: string }).title)).not.toContain("What you wrote could not be copied");
  });

  // r32 review F1: what is selected by hand is the text exactly as typed, as an automatic copy is.
  it("quotes the text to copy by hand exactly as typed, its spaces and blank lines kept", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const typed = "    indented text\n\n";
    const tree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" conversationId="c1" onRoomGone={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: typed } });
    roomError = roomGone();
    rerender(tree());

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { description: string; verbatim?: boolean };
    expect(notice.description).toContain(`“${typed}”`);
    expect(notice.verbatim).toBe(true);
  });

  it("offers the text to copy by hand from the start where there is no clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const long = "x".repeat(260);
    send.mockRejectedValueOnce(roomGone());
    open(vi.fn());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: long } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { description: string; onClick?: unknown; keep: boolean };
    expect(notice.description).toMatch(/Select the text below and copy it by hand:\n/);
    expect(notice.description).toContain(`“${long}”`);
    expect(notice.onClick).toBeUndefined();
    expect(notice.keep).toBe(true);
  });

  it("hands back the room its own first send opened, when that room is deleted before the message lands", async () => {
    send.mockRejectedValueOnce(roomGone());
    const backToList = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" onRoomGone={backToList} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "are we still on?" } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(backToList).toHaveBeenCalledWith("c9"));
    expect(openRoom).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "This room was deleted", description: expect.stringMatching(/not sent/) }),
    );
    expect(screen.queryByText("Try again")).not.toBeInTheDocument();
  });

  it("hands back to the list when reading it again finds it gone", async () => {
    roomError = roomGone();
    const backToList = vi.fn();
    open(backToList);
    await waitFor(() => expect(backToList).toHaveBeenCalledWith("c1"));
    // The refusal's own face, as every other refusal toast wears it (r29, the master's ruling).
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "This room was deleted", tone: "error" }));
    expect(screen.queryByText("Couldn't load this conversation")).not.toBeInTheDocument();
  });

  // r30, judge-86: what was typed and not yet sent vanished with the room when its deletion arrived.
  it("keeps what was typed and not yet sent when the room is found deleted", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const tree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" conversationId="c1" onRoomGone={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "half a thought about the invoices" } });

    roomError = roomGone();
    rerender(tree());
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { description: string; keep: boolean; onClick: () => void };
    expect(notice).toMatchObject({ title: "This room was deleted", keep: true, tone: "error" });
    expect(notice.description).toContain("“half a thought about the invoices”");
    // r31, judge-88: nobody pressed Send, so nothing "was not sent"; what was being written is kept.
    expect(notice.description).toContain("What you were writing is kept below — select it to copy.");
    expect(notice.description).not.toMatch(/not sent/);
    notice.onClick();
    expect(writeText).toHaveBeenCalledWith("half a thought about the invoices");
    expect(send).not.toHaveBeenCalled();
  });

  // r30 review F2: the kept text was trimmed, so indentation and trailing lines were lost.
  it("keeps the draft exactly as typed, indentation and trailing lines included", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const typed = "    indented text\n\n";
    const tree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" conversationId="c1" onRoomGone={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: typed } });
    roomError = roomGone();
    rerender(tree());
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { description: string; onClick: () => void };
    expect(notice.description).toContain("“indented text”");
    notice.onClick();
    expect(writeText).toHaveBeenCalledWith(typed);
  });

  it("raises the plain notice where nothing was typed, saying once that the room was deleted", async () => {
    roomError = roomGone();
    open(vi.fn());
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0]?.[0]).toMatchObject({
      title: "This room was deleted",
      description: "It has left your list.",
    });
    expect(toast.mock.calls[0]?.[0]).not.toHaveProperty("keep", true);
  });

  it("still offers Try again for a send that failed for any other reason", async () => {
    send.mockRejectedValueOnce(new Error("network"));
    open();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(await screen.findByText("Try again")).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });
});

// r32, judge-90: with the keyboard up at 390 the bars above and below a room left about 50 px of thread.
describe("a room's message box with focus", () => {
  const marked = () => document.documentElement.dataset.composing !== undefined;
  const scoped = () => detail({ scopeProjects: [{ id: "p1", name: "Desk", slug: "desk" }] });

  it("on a phone marks the document and folds the About panel, until focus leaves the box", () => {
    room = scoped();
    open();
    const about = screen.getByRole("button", { name: /About Desk/ });
    expect(about).toHaveAttribute("aria-expanded", "true");
    fireEvent.focusIn(screen.getByLabelText("Message"));
    expect(marked()).toBe(true);
    expect(about).toHaveAttribute("aria-expanded", "false");
    fireEvent.focusOut(screen.getByLabelText("Message"), { relatedTarget: null });
    expect(marked()).toBe(false);
    expect(about).toHaveAttribute("aria-expanded", "true");
  });

  it("on a wide screen leaves the document and the About panel as they were", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      room = scoped();
      open();
      fireEvent.focusIn(screen.getByLabelText("Message"));
      expect(marked()).toBe(false);
      expect(screen.getByRole("button", { name: /About Desk/ })).toHaveAttribute("aria-expanded", "true");
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});

// r34, judge-93: a room whose only agent cannot answer still invited "Ask the agent anything", beside
// "Read-only access" for a viewer. An empty room says what is true and invites only what can be done.
describe("an empty room", () => {
  const desk = { id: "p1", name: "Desk", slug: "desk" };
  const emptyPane = () => within(screen.getByTestId("conversation-empty"));
  const agent = (over: Partial<ConversationDetail["participants"][number]> = {}) => ({
    id: "h-desk",
    kind: "handle" as const,
    userId: "u-desk",
    projectId: "p1",
    label: null,
    displayName: "desk",
    reachable: true,
    ...over,
  });

  it("invites a conversation where an agent can answer and the reader can post", () => {
    room = detail({ participants: [agent()], scopeProjects: [desk], scope: ["p1"] });
    open();
    expect(emptyPane().getByText("Start a conversation")).toBeInTheDocument();
  });

  it("says no agent here can answer, naming it and why, where its only agent lost its role", () => {
    room = detail({ participants: [agent({ reachable: false })], scopeProjects: [desk], scope: ["p1"] });
    open();
    expect(emptyPane().getByText("No agent here can answer")).toBeInTheDocument();
    expect(emptyPane().getByText(/@desk can't answer: it no longer holds a role on Desk/)).toBeInTheDocument();
    expect(emptyPane().queryByText("Start a conversation")).not.toBeInTheDocument();
    expect(emptyPane().queryByText(/Ask the agent anything/)).not.toBeInTheDocument();
  });

  it("names every agent that cannot answer when none of several can", () => {
    const ops = { id: "p2", name: "Ops", slug: "ops" };
    room = detail({
      shape: "group",
      participants: [
        agent({ reachable: false }),
        agent({ id: "h-ops", userId: "u-ops", projectId: "p2", displayName: "ops", reachable: false }),
      ],
      scopeProjects: [desk, ops],
      scope: ["p1", "p2"],
    });
    open();
    expect(emptyPane().getByText("No agent here can answer")).toBeInTheDocument();
    expect(emptyPane().getByText(/@desk can't answer: it no longer holds a role on Desk, and answers again once it does\..*@ops can't answer: it no longer holds a role on Ops, and answers again once it does\./)).toBeInTheDocument();
  });

  it("keeps the invitation where one agent of two can still answer", () => {
    room = detail({
      participants: [agent(), agent({ id: "h-2", userId: "u-2", displayName: "desk-2", reachable: false })],
      scopeProjects: [desk],
      scope: ["p1"],
    });
    open();
    expect(emptyPane().getByText("Start a conversation")).toBeInTheDocument();
  });

  it("tells a viewer they can read the room and not post, inviting nothing", () => {
    projectRole = "viewer";
    room = detail({ participants: [agent()], scopeProjects: [desk], scope: ["p1"] });
    open();
    expect(emptyPane().getByText("Nothing has been said here yet")).toBeInTheDocument();
    expect(emptyPane().getByText("You can read this room, not post in it: you hold the viewer role on Desk.")).toBeInTheDocument();
    expect(emptyPane().queryByText("Start a conversation")).not.toBeInTheDocument();
    expect(emptyPane().queryByText(/Ask the agent anything/)).not.toBeInTheDocument();
  });

  it("tells a viewer both, where no agent can answer either", () => {
    projectRole = "viewer";
    room = detail({ participants: [agent({ reachable: false })], scopeProjects: [desk], scope: ["p1"] });
    open();
    expect(emptyPane().getByText("No agent here can answer")).toBeInTheDocument();
    expect(emptyPane().getByText(/@desk can't answer: it no longer holds a role on Desk, and answers again once it does\. You can read this room, not post in it/)).toBeInTheDocument();
  });

  it("does not invite a conversation in a room whose message box is refused for spanning two projects", () => {
    const ops = { id: "p2", name: "Ops", slug: "ops" };
    room = detail({
      shape: "group",
      participants: [agent(), agent({ id: "h-ops", userId: "u-ops", projectId: "p2", displayName: "ops" })],
      scopeProjects: [desk, ops],
      scope: ["p1", "p2"],
    });
    open();
    expect(emptyPane().queryByText("Start a conversation")).not.toBeInTheDocument();
    expect(emptyPane().getByText("Nothing can be sent here")).toBeInTheDocument();
  });

  it("tells a viewer opening a new conversation that they can read this project's conversations, not start one", () => {
    projectRole = "viewer";
    room = undefined;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationChat projectId="p1" />
      </QueryClientProvider>,
    );
    expect(emptyPane().getByText("You can read Desk's conversations, not start one: you hold the viewer role on Desk.")).toBeInTheDocument();
    expect(emptyPane().queryByText("Start a conversation")).not.toBeInTheDocument();
  });
});

// r35, judge-95: a room whose only agent lost its role still offered its message box; the owner's first
// message was taken in, answered 500, and the explanation left the screen once the room held a message.
// A viewer of one of a two-project room's projects was told to take an agent out, which they cannot.
describe("a room nothing can be sent to", () => {
  const desk = { id: "p1", name: "Desk", slug: "desk" };
  const ops = { id: "p2", name: "Ops", slug: "ops" };
  const agent = (over: Partial<ConversationDetail["participants"][number]> = {}) => ({
    id: "h-desk",
    kind: "handle" as const,
    userId: "u-desk",
    projectId: "p1",
    label: null,
    displayName: "desk",
    reachable: true,
    ...over,
  });
  const said = {
    id: "m1",
    seq: 0,
    role: "user" as const,
    authorUserId: "u1",
    authorLabel: "Mai",
    content: "Which issues are open?",
    silenceReason: null,
    createdAt: "2026-10-22T02:30:00Z",
  };
  const footer = () => screen.getByTestId("composer-no-answer");

  it("offers no message box where no agent can answer, and says so in its place", () => {
    room = detail({ participants: [agent({ reachable: false })], scopeProjects: [desk], scope: ["p1"] });
    open();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(within(footer()).getByText("No agent here can answer, so nothing can be sent here.")).toBeInTheDocument();
  });

  it("names each agent and why in the box's place once the room holds messages", () => {
    room = detail({
      participants: [agent({ reachable: false })],
      scopeProjects: [desk],
      scope: ["p1"],
      messages: [said],
    });
    open();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(within(footer()).getByText("No agent here can answer, so nothing can be sent here.")).toBeInTheDocument();
    expect(within(footer()).getByText(/@desk can't answer: it no longer holds a role on Desk, and answers again once it does\./)).toBeInTheDocument();
  });

  it("keeps the message box where one agent can still answer", () => {
    room = detail({ participants: [agent()], scopeProjects: [desk], scope: ["p1"], messages: [said] });
    open();
    expect(screen.getByLabelText("Message")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-no-answer")).not.toBeInTheDocument();
  });

  it("never tells a viewer of one of a room's projects to take an agent out", () => {
    projectRole = "member";
    otherProjects = [{ id: "p2", name: "Ops", role: "viewer" }];
    room = detail({
      shape: "group",
      participants: [agent(), agent({ id: "h-ops", userId: "u-ops", projectId: "p2", displayName: "ops" })],
      scopeProjects: [desk, ops],
      scope: ["p1", "p2"],
      canChangeMembership: false,
    });
    open();
    expect(screen.queryByText(/[Tt]ake one of its agents out/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("conversation-empty")).getByText(
        "You can read this room, not post in it: you hold the viewer role on Ops.",
      ),
    ).toBeInTheDocument();
  });

  it("offers taking an agent out only to a reader who may, and tells any other poster who can", () => {
    otherProjects = [{ id: "p2", name: "Ops", role: "member" }];
    const twoProjects = () =>
      detail({
        shape: "group",
        participants: [agent(), agent({ id: "h-ops", userId: "u-ops", projectId: "p2", displayName: "ops" })],
        scopeProjects: [desk, ops],
        scope: ["p1", "p2"],
      });
    room = twoProjects();
    open();
    expect(within(screen.getByTestId("composer-refused")).getByText("Take one of its agents out, and the room can be spoken in again.")).toBeInTheDocument();
    cleanup();
    room = { ...twoProjects(), canChangeMembership: false };
    open();
    expect(screen.queryByText(/^Take one of its agents out/)).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("composer-refused")).getByText(
        "Somebody who can change who is in this room can take one of its agents out, and it can be spoken in again.",
      ),
    ).toBeInTheDocument();
  });
});

