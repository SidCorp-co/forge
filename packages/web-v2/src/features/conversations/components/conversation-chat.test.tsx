// @vitest-environment jsdom
//
// ISS-1146 — the wiring this pane owns: the staged file reaches the room
// before the message that cites it, the composer says which mode the room is
// in, and the header no longer tells an Agent room it cannot see a repository.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let room: ConversationDetail | undefined;
let progress: { entry: string; replaced?: boolean } | null = null;
let sendPending = false;

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

vi.mock("../hooks", () => ({
  useConversation: () => ({ data: room, isLoading: false, isError: false, isSuccess: true }),
  useAcceptedMessages: () => ({}),
  useConversationProgress: () => progress,
  useWithdrawnDrafts: () => ({}),
  useDraftAgentMode: () => ({ data: { available: true, reason: null } }),
  useOpenConversation: () => ({ isPending: false, mutateAsync: vi.fn() }),
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
  room = detail();
  progress = null;
  sendPending = false;
});

function fileOf(name: string, type: string): File {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: 64 });
  return f;
}

function open() {
  render(<ConversationChat projectId="p1" conversationId="c1" />);
}

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
