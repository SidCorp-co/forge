// @vitest-environment jsdom
//
// ISS-1236 r6, judge-140: a send whose answer was lost after core wrote the message showed the message
// as delivered and, below it, a second copy marked "Couldn't send" until Try again was pressed. The
// room read now carries the sender's own token, so the thread knows the message it shows is the send.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationMessage } from "./types";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

let stored: ConversationMessage[] = [];
const detail = vi.fn(async (id: string): Promise<ConversationDetail> => room(id, stored));
const send = vi.fn();

vi.mock("./api", () => ({
  conversationsApi: {
    detail: (id: string) => detail(id),
    send: (...args: unknown[]) => send(...args),
    open: vi.fn(),
    upload: vi.fn(),
    stop: vi.fn(),
    draftAgentMode: vi.fn(async () => ({ available: true, reason: null, unbound: null })),
    candidates: vi.fn(async () => []),
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Desk", role: "admin" }] }),
}));
vi.mock("./components/conversation-members", () => ({ ConversationMembers: () => null }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConversationChat } = await import("./components/conversation-chat");

function room(id: string, messages: ConversationMessage[]): ConversationDetail {
  return {
    id,
    adapter: "web",
    externalId: `web ${id}`,
    shape: "direct",
    mode: "assistant",
    // Named, so the heading is not the first message and the thread is the only place it shows.
    title: "Standup",
    updatedAt: "2026-10-27T10:00:00.000Z",
    archivedAt: null,
    messages,
    windows: [],
    agentTurns: [],
    agentMode: { available: true, reason: null, unbound: null },
    participants: [],
    scope: [],
    scopeProjects: [],
    canChangeMembership: true,
  };
}

function written(content: string, clientToken: string | null): ConversationMessage {
  return {
    id: "m-written",
    seq: 0,
    role: "user",
    authorUserId: "u1",
    authorLabel: "You",
    content,
    silenceReason: null,
    clientToken,
    createdAt: "2026-10-27T10:00:01.000Z",
  };
}

let qc: QueryClient;
beforeEach(() => {
  stored = [];
  detail.mockClear();
  send.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function sendTyped(text: string) {
  render(
    <QueryClientProvider client={qc}>
      <ConversationChat projectId="p1" conversationId="c1" />
    </QueryClientProvider>,
  );
  return waitFor(() => expect(screen.getByLabelText("Message")).toBeInTheDocument()).then(() => {
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
    fireEvent.click(screen.getByLabelText("Send message"));
  });
}

/** Core writes the message, then the answer never reaches the browser. */
function answerLostAfterTheWrite(frameLostToo: boolean) {
  send.mockImplementation(async (id: string, content: string, _mode: unknown, token: string) => {
    stored = [written(content, token)];
    if (!frameLostToo) {
      qc.setQueryData(["conversations", id, "accepted"], { [token]: { messageId: "m-written", seq: 0 } });
    }
    throw new TypeError("Failed to fetch");
  });
}

describe("a send whose answer is lost after core wrote it", () => {
  it("shows the message once, as sent, with no Couldn't send and no Try again pressed", async () => {
    answerLostAfterTheWrite(true);
    await sendTyped("is the build green?");

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Couldn't send/)).not.toBeInTheDocument());
    expect(screen.getAllByText("is the build green?")).toHaveLength(1);
    expect(screen.queryByText("Try again")).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("clears the failure once a pushed event has the room read again", async () => {
    answerLostAfterTheWrite(true);
    detail.mockImplementation(async (id: string) => room(id, []));
    await sendTyped("deploy at five");
    await waitFor(() => expect(screen.getByText(/Couldn't send/)).toBeInTheDocument());

    detail.mockImplementation(async (id: string) => room(id, stored));
    await qc.invalidateQueries({ queryKey: ["conversations", "c1"], exact: true });

    await waitFor(() => expect(screen.queryByText(/Couldn't send/)).not.toBeInTheDocument());
    expect(screen.getAllByText("deploy at five")).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("shows it once when the accepted frame arrived before the answer was lost", async () => {
    answerLostAfterTheWrite(false);
    await sendTyped("ship it");

    await waitFor(() => expect(screen.getAllByText("ship it")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Couldn't send/)).not.toBeInTheDocument());
  });

  it("still says Couldn't send when the room holds no message under its token", async () => {
    send.mockRejectedValue(new TypeError("Failed to fetch"));
    stored = [written("someone else's words", null)];
    await sendTyped("never written");

    await waitFor(() => expect(screen.getByText(/Couldn't send/)).toBeInTheDocument());
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });
});
