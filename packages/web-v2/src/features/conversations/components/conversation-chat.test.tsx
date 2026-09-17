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
const agentMode = vi.fn(
  async (_projectId: string): Promise<{ available: boolean; reason: string | null }> => ({
    available: true,
    reason: null,
  }),
);

vi.mock("../api", () => ({
  conversationsApi: {
    open: (...a: unknown[]) => open(...a),
    send: (...a: unknown[]) => send(...a),
    detail: (...a: unknown[]) => detail(...a),
    agentMode: (projectId: string) => agentMode(projectId),
    list: async () => ({ items: [], total: 0 }),
    rename: async () => ({}),
    remove: async () => undefined,
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Alpha", slug: "alpha", role: "member" }] }),
}));
// cm:guard the double takes the message as an ARGUMENT so a test can send two different ones, and
// it never reads `busy`: the real composer accepts a send while busy only when the caller passes
// `queueWhileBusy`, and this chat does. A double that refused while busy would make the queue below
// untestable and would have passed against the defect (ISS-1031).
let nextMessage = "is the release ready?";
vi.mock("@/features/session/components/composer", () => ({
  Composer: ({ onSend }: { onSend: (m: string) => Promise<void> }) => (
    <button type="button" onClick={() => void onSend(nextMessage)}>
      send
    </button>
  ),
  ReadOnlyComposerNote: () => null,
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConversationChat } = await import("./conversation-chat");
const { routeEvent } = await import("@/lib/ws/event-router");
const { flushInvalidations } = await import("@/lib/ws/invalidation-coalescer");

afterEach(cleanup);

beforeEach(() => {
  nextMessage = "is the release ready?";
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
    expect(open).toHaveBeenCalledWith({ projectId: "p1" });
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

// cm:guard ISS-1031 — `POST /conversations/:id/messages` does not return until the agent turn is
// over, so before this the thread could not show a person's own question until the answer arrived
// with it: the words sat in the box and the room looked untouched for the whole wait. These four
// cases are that behaviour, and each was watched failing against the code as it stood.
describe("ConversationChat \u00b7 what a person sees between pressing send and being answered", () => {
  it("shows the message in the thread before the server has answered", async () => {
    let answer: (v: unknown) => void = () => undefined;
    send.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });

    // The server has said nothing yet and the question is already on screen.
    expect(screen.getByText("is the release ready?")).toBeInTheDocument();
    expect(screen.getByTestId("thread-outbox-sending")).toBeInTheDocument();
    await act(async () => {
      answer({ conversationId: "c1", windowId: "w1", seq: 0, decision: "answered", messages: [], windows: [] });
    });
  });

  it("queues a second question typed while the first is still being answered", async () => {
    let answer: (v: unknown) => void = () => undefined;
    send.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));

    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    nextMessage = "and how many are blocked?";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });

    // Visible, and NOT sent: one request is in flight, and the room serialises.
    expect(screen.getByText("and how many are blocked?")).toBeInTheDocument();
    expect(screen.getByTestId("thread-outbox-queued")).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer({ conversationId: "c1", windowId: "w1", seq: 0, decision: "answered", messages: [], windows: [] });
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]?.[1]).toBe("and how many are blocked?");
  });

  it("keeps the words and says why when the send is refused", async () => {
    send.mockRejectedValue(new Error("no online runner"));

    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });

    await waitFor(() => expect(screen.getByTestId("thread-outbox-failed")).toBeInTheDocument());
    expect(screen.getByText("is the release ready?")).toBeInTheDocument();
    expect(screen.getByText(/Couldn't send/)).toBeInTheDocument();
  });

  it("stops the queue at a refusal rather than sending what was behind it", async () => {
    send.mockRejectedValue(new Error("no online runner"));

    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(screen.getByTestId("thread-outbox-failed")).toBeInTheDocument());

    nextMessage = "and how many are blocked?";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });

    // The second is held, not fired into a room whose first question was refused.
    expect(screen.getByTestId("thread-outbox-queued")).toBeInTheDocument();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("drops the optimistic row once the stored messages carry it", async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(screen.getByText("two issues left")).toBeInTheDocument());

    // cm:why the heading renders the first message's text too, so the count is taken inside the
    // thread rather than over the document — asserting over the whole screen counts the title.
    expect(screen.queryByTestId("thread-outbox-sending")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-outbox-queued")).not.toBeInTheDocument();
    expect(screen.queryByTestId("thread-outbox-failed")).not.toBeInTheDocument();
    const said = screen
      .getAllByText("is the release ready?")
      .filter((el) => el.closest("h1") === null);
    expect(said).toHaveLength(1);
  });
});

// cm:guard ISS-1011 review F6 — whether this caller may change the membership is the SERVER's answer, and the mock here holds a caller who is a `member` on the project and still may not: that is a real combination, because changing membership also takes being a live person in the room, which no project role implies. A screen inferring the capability from the project role offers the control and the server refuses it, which reads as a broken button rather than as a rule.
describe("ConversationChat · who may change who is in the room", () => {
  const roomWith = (extra: Record<string, unknown>) => ({
    id: "c1",
    adapter: "web",
    externalId: "v1",
    shape: "direct",
    title: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    scope: ["p1"],
    scopeProjects: [{ id: "p1", name: "Alpha", slug: "alpha" }],
    participants: [
      {
        id: "pp1",
        kind: "person",
        userId: "u1",
        projectId: null,
        label: null,
        displayName: "Ada",
        reachable: null,
      },
    ],
    messages: [],
    windows: [],
    ...extra,
  });

  const openRoster = async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConversationChat projectId="p1" conversationId="c1" />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Who is in this room" }));
  };

  it("offers no way in or out to a caller the server says may not change it", async () => {
    detail.mockResolvedValue(roomWith({ canChangeMembership: false }));
    await openRoster();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add agent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add person/i })).not.toBeInTheDocument();
  });

  it("offers them to a caller the server says may", async () => {
    detail.mockResolvedValue(roomWith({ canChangeMembership: true }));
    await openRoster();
    expect(await screen.findByRole("button", { name: /add agent/i })).toBeInTheDocument();
  });

  // cm:guard an ANSWER that carried no such field is read as "may not", not as "may": a tab open across the deploy of the half that added it would otherwise show controls whose every use the server refuses.
  it("offers nothing where the room's answer does not carry the capability at all", async () => {
    detail.mockResolvedValue(roomWith({}));
    await openRoster();
    expect(await screen.findByText("Ada")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add agent/i })).not.toBeInTheDocument();
  });
});

// cm:guard ISS-1039 criteria 1, 2, 15 and 16 — the pick between Assistant and Agent is offered in
// the COMPOSER of an empty room and nowhere else, and Agent is offered disabled-with-a-reason on a
// project that has no box to run it. Each case here was watched going red: hiding the control
// unconditionally kills the first, rendering it unconditionally kills the second, and dropping the
// server's `agentMode` on the floor kills the last two.
describe("ConversationChat · picking what the room talks to", () => {
  const emptyRoom = (agentMode: { available: boolean; reason: string | null }) => ({
    id: "c1",
    adapter: "web",
    externalId: "v1",
    shape: "direct",
    title: null,
    mode: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    scope: ["p1"],
    scopeProjects: [{ id: "p1", name: "Alpha", slug: "alpha" }],
    participants: [],
    messages: [],
    windows: [],
    agentMode,
    agentTurns: [],
  });

  function mountRoom() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <ConversationChat projectId="p1" conversationId="c1" />
      </QueryClientProvider>,
    );
  }

  it("offers both modes in an empty room", async () => {
    detail.mockResolvedValue(emptyRoom({ available: true, reason: null }));
    mountRoom();
    await waitFor(() => expect(screen.getByTestId("conversation-mode-toggle")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Assistant" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Agent" })).toBeEnabled();
  });

  it("offers nothing to pick once the room holds a message", async () => {
    detail.mockResolvedValue({
      ...emptyRoom({ available: true, reason: null }),
      mode: "assistant",
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
      ],
    });
    mountRoom();
    // cm:why the title renders the first message's text too, so the wait is on ALL of them: a
    // `getByText` here fails on the second copy rather than on the behaviour being asserted.
    await waitFor(() =>
      expect(screen.getAllByText("is the release ready?").length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("conversation-mode-toggle")).not.toBeInTheDocument();
  });

  it("offers Agent disabled, with the server's own reason, where no box can take it", async () => {
    detail.mockResolvedValue(
      emptyRoom({ available: false, reason: "no device is paired with Alpha" }),
    );
    mountRoom();
    await waitFor(() => expect(screen.getByTestId("conversation-mode-toggle")).toBeInTheDocument());
    const agent = screen.getByRole("radio", { name: "Agent" });
    expect(agent).toBeDisabled();
    // cm:guard the reason is READ OFF the server's answer and never composed here: a screen that
    // writes its own sentence tells a person to pair a box when the real refusal was something else.
    expect(screen.getByText(/no device is paired with Alpha/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Assistant" })).toBeEnabled();
  });

  it("sends the mode the person picked", async () => {
    detail.mockResolvedValue(emptyRoom({ available: true, reason: null }));
    mountRoom();
    await waitFor(() => expect(screen.getByTestId("conversation-mode-toggle")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[2]).toBe("agent");
  });
});

// cm:guard the composer of a DRAFT is where this pick is usually made — there is no room yet, so the
// room's own `agentMode` cannot answer, and the screen was offering Agent enabled on the strength of
// nothing. A person on a project with no box paired then composed a question and learned from the
// refusal. Criteria 15 and 16 are about the control being right BEFORE a message is spent
// (ISS-1039, commit consult F5).
describe("ConversationChat \u00b7 the pick before any room exists", () => {
  function mountDraft() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <ConversationChat projectId="p1" />
      </QueryClientProvider>,
    );
  }

  it("asks the project whether a box is free, with no room in hand", async () => {
    agentMode.mockResolvedValue({ available: true, reason: null });
    mountDraft();
    await waitFor(() => expect(agentMode).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Agent" })).toBeEnabled());
  });

  it("offers Agent disabled, with the project's own reason, where no box is paired", async () => {
    agentMode.mockResolvedValue({ available: false, reason: "this project has no box paired" });
    mountDraft();
    // cm:why the wait is on the REASON and not on the disabled state: the control is disabled while
    // the read is still in flight too, so waiting on that alone passes before the answer arrives and
    // asserts the loading sentence.
    await waitFor(() => expect(screen.getByText(/no box paired/)).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Agent" })).toBeDisabled();
  });

  // cm:guard an unknown is not a yes: while the read is in flight the control is disabled and says
  // what it is doing, because offering it and refusing the send a second later is the same lie.
  it("holds Agent closed while it does not yet know", async () => {
    let answer: (v: { available: boolean; reason: string | null }) => void = () => undefined;
    agentMode.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    mountDraft();
    await waitFor(() => expect(screen.getByRole("radio", { name: "Agent" })).toBeDisabled());
    expect(screen.getByText(/checking whether a box is free/)).toBeInTheDocument();
    await act(async () => {
      answer({ available: true, reason: null });
    });
  });
});

// cm:guard criterion 1 and criterion 2 together, at the seam where they can disagree: acceptance
// must stop the label AND must not take the question off the screen. The two are asserted in one
// render because a screen that dropped the row passes the first read on its own, and a screen that
// never cleared the label passes the second.
describe("ConversationChat · a message the server has filed", () => {
  const room = (messages: unknown[]) => ({
    id: "c1",
    adapter: "web",
    externalId: "v1",
    shape: "direct",
    title: null,
    updatedAt: "2026-09-14T00:00:00.000Z",
    scope: ["p1"],
    participants: [],
    messages,
    windows: [],
  });

  /** A send that never returns — which is what the real one does for the whole agent turn. */
  const hangingSend = () => {
    send.mockImplementation(() => new Promise(() => undefined));
  };

  const mountOpenRoom = (messages: unknown[] = []) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    detail.mockImplementation(async () => room(messages));
    const view = render(
      <QueryClientProvider client={qc}>
        <ConversationChat projectId="p1" conversationId="c1" />
      </QueryClientProvider>,
    );
    return { qc, view };
  };

  it("stops saying Sending, and keeps the question, until its durable row arrives", async () => {
    hangingSend();
    const { qc } = mountOpenRoom();
    await screen.findByRole("button", { name: "send" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(screen.getByText("Sending…")).toBeInTheDocument());

    const token = send.mock.calls[0]?.[3] as string;
    expect(token).toEqual(expect.any(String));

    // The server files the message and says so, carrying this tab's own token.
    await act(async () => {
      routeEvent(
        {
          event: "conversation.accepted",
          data: { conversationId: "c1", messageId: "m0", seq: 0, clientToken: token },
          timestamp: "2026-09-14T00:00:00.000Z",
        },
        qc,
      );
      flushInvalidations();
    });

    await waitFor(() => expect(screen.queryByText("Sending…")).toBeNull());
    expect(screen.getByText("is the release ready?")).toBeInTheDocument();

    // ...and only when the durable row is actually in the room does the unsent copy go.
    await act(async () => {
      qc.setQueryData(["conversations", "c1"], room([
        {
          id: "m0",
          seq: 0,
          role: "user",
          authorUserId: "u1",
          authorLabel: "Ada",
          content: "is the release ready?",
          blocks: null,
          silenceReason: null,
          createdAt: "2026-09-14T00:00:00.000Z",
        },
      ]));
    });

    await waitFor(() =>
      expect(screen.getAllByText("is the release ready?")).toHaveLength(1),
    );
  });

  // cm:guard criteria 3 to 5 and 7 where a person meets them: the turn draws as it arrives, and the
  // "Agent is working…" placeholder — which was the whole of what a person saw — goes the moment
  // there is something real to show instead.
  it("draws the streaming turn in place of the working label", async () => {
    hangingSend();
    const { qc } = mountOpenRoom();
    await screen.findByRole("button", { name: "send" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "send" }));
    });
    await waitFor(() => expect(screen.getByText("Agent is working…")).toBeInTheDocument());

    await act(async () => {
      routeEvent(
        {
          event: "conversation.progress",
          data: {
            conversationId: "c1",
            entry: {
              id: "entry-1",
              type: "assistant",
              blocks: [
                { type: "tool", toolCall: { id: "t1", name: "forge_issues", input: {} } },
                { type: "text", text: "reading the issues" },
              ],
            },
          },
          timestamp: "2026-09-14T00:00:00.000Z",
        },
        qc,
      );
      flushInvalidations();
    });

    await waitFor(() => expect(screen.getByText("reading the issues")).toBeInTheDocument());
    expect(screen.getByText(/forge_issues/)).toBeInTheDocument();
    expect(screen.queryByText("Agent is working…")).toBeNull();
  });
});
