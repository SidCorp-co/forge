// @vitest-environment jsdom
//
// ISS-1004 step 5, review F3 — the first message of a NEW conversation.
//
// A draft has no room until it is sent into, so one call chain opens the room
// and then sends. Everything about that chain looks right at a glance and the
// screen shows nothing wrong: the failure is the id the send is built with, and
// the only place it is visible is the URL the API was called on.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

// cm:why jsdom implements no scrolling at all, and the thread pins itself to its newest message on every mount — without this stub the component throws before any assertion here is reached
Element.prototype.scrollIntoView = vi.fn();

const open = vi.fn();
const send = vi.fn();
const detail = vi.fn();

vi.mock("../api", () => ({
  conversationsApi: {
    open: (...a: unknown[]) => open(...a),
    send: (...a: unknown[]) => send(...a),
    detail: (...a: unknown[]) => detail(...a),
    list: async () => ({ items: [], total: 0 }),
    rename: async () => ({}),
    remove: async () => undefined,
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Alpha", slug: "alpha", role: "member" }] }),
}));
vi.mock("@/features/session/components/composer", () => ({
  Composer: ({ onSend }: { onSend: (m: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onSend("is the release ready?")}>
      send
    </button>
  ),
  ReadOnlyComposerNote: () => null,
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConversationChat } = await import("./conversation-chat");

afterEach(cleanup);

beforeEach(() => {
  open.mockReset();
  send.mockReset();
  detail.mockReset();
  open.mockResolvedValue({
    id: "c1",
    adapter: "web",
    externalId: "v1",
    shape: "direct",
    title: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
  });
  send.mockResolvedValue({
    conversationId: "c1",
    windowId: "w1",
    seq: 0,
    decision: "answered",
    messages: [
      {
        id: "m0",
        seq: 0,
        role: "user",
        authorUserId: "u1",
        authorLabel: "Ada",
        content: "is the release ready?",
        silenceReason: null,
        createdAt: "2026-09-14T00:00:00.000Z",
      },
      {
        id: "m1",
        seq: 1,
        role: "assistant",
        authorUserId: null,
        authorLabel: null,
        content: "two issues left",
        silenceReason: null,
        createdAt: "2026-09-14T00:00:01.000Z",
      },
    ],
    windows: [
      { id: "w1", firstSeq: 0, lastSeq: 0, closedAt: "2026-09-14T00:00:01.000Z", decision: "answered", decisionDetail: null },
    ],
  });
  // cm:why the room reads back with what the send left in it, because that is what the server holds by the time any read of it lands — a mock returning an empty room would be asserting a race rather than the behaviour
  detail.mockImplementation(async () => ({
    id: "c1",
    adapter: "web",
    externalId: "v1",
    shape: "direct",
    title: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    scope: ["p1"],
    participants: [],
    messages: (await send.mock.results[0]?.value)?.messages ?? [],
    windows: (await send.mock.results[0]?.value)?.windows ?? [],
  }));
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationChat projectId="p1" />
    </QueryClientProvider>,
  );
}

describe("ConversationChat · the first message of a draft", () => {
  it("sends into the room it just opened, not into no room at all", async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith("p1", undefined);
    expect(send.mock.calls[0]?.[0]).toBe("c1");
  });

  it("shows what came back from that send", async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(screen.getByText("two issues left")).toBeInTheDocument());
  });
});
