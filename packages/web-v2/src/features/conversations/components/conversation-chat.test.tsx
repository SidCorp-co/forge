// @vitest-environment jsdom
//
// ISS-1146 — the wiring this pane owns: the staged file reaches the room
// before the message that cites it, the composer says which mode the room is
// in, and the header no longer tells an Agent room it cannot see a repository.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", role: "admin" }] }),
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
    await waitFor(() =>
      expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: "What you wrote was copied" })),
    );
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
    reject(new Error("aborted"));
  });

  it("shows the whole unsent message where it cannot be copied", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const long = "x".repeat(260);
    send.mockRejectedValueOnce(roomGone());
    open(vi.fn());
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: long } });
    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    const notice = toast.mock.calls[0]?.[0] as { description: string; onClick: () => void };
    expect(notice.description).toContain(`“${"x".repeat(200)}…”`);
    notice.onClick();
    await waitFor(() =>
      expect(toast).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "What you wrote could not be copied", description: long, keep: true }),
      ),
    );
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
    notice.onClick();
    expect(writeText).toHaveBeenCalledWith("half a thought about the invoices");
    expect(send).not.toHaveBeenCalled();
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
