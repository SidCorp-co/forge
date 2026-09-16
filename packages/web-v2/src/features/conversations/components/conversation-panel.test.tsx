// @vitest-environment jsdom
//
// ISS-1028 — the Ask agent panel: what it opens on, and the way back.
//
// ISS-732 made opening the panel start a NEW chat, and said History would stay
// reachable. It stayed reachable on the full-page Conversations screen and
// nowhere in the panel, so closing the panel read as losing the conversation.
// Every case here is one half of that pair: nothing is resumed on open, and the
// list is on screen and reachable anyway.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

// cm:why jsdom implements no scrolling at all, and the thread pins itself to its newest message on every mount — without this stub the component throws before any assertion here is reached
Element.prototype.scrollIntoView = vi.fn();

const list = vi.fn();
const detail = vi.fn();
const rename = vi.fn();
const remove = vi.fn();
const setArchived = vi.fn();
const openRoom = vi.fn();
const sendMsg = vi.fn();

vi.mock("../api", () => ({
  conversationsApi: {
    list: (...a: unknown[]) => list(...a),
    detail: (...a: unknown[]) => detail(...a),
    rename: (...a: unknown[]) => rename(...a),
    remove: (...a: unknown[]) => remove(...a),
    setArchived: (...a: unknown[]) => setArchived(...a),
    open: (...a: unknown[]) => openRoom(...a),
    send: (...a: unknown[]) => sendMsg(...a),
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Alpha", slug: "alpha", role: "member" }] }),
}));
vi.mock("@/features/session/components/composer", () => ({
  Composer: ({ onSend }: { onSend: (m: string) => Promise<void> }) => (
    <button type="button" data-testid="composer" onClick={() => void onSend("hello")}>
      send
    </button>
  ),
  ReadOnlyComposerNote: () => null,
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConversationPanel } = await import("./conversation-panel");

const roomRow = (id: string, title: string, archivedAt: string | null = null) => ({
  id,
  adapter: "web" as const,
  externalId: `v-${id}`,
  shape: "direct" as const,
  title,
  updatedAt: "2026-09-14T00:00:00.000Z",
  archivedAt,
});

const live = [roomRow("c1", "Release plan"), roomRow("c2", "Runner budget")];
const archived = [roomRow("c3", "Old migration", "2026-09-10T00:00:00.000Z")];

afterEach(cleanup);

beforeEach(() => {
  for (const m of [list, detail, rename, remove, setArchived, openRoom, sendMsg]) m.mockReset();
  openRoom.mockResolvedValue(roomRow("cNew", "Brand new"));
  sendMsg.mockResolvedValue({ conversationId: "cNew", messages: [], windows: [] });
  // cm:guard the mock branches on the ARCHIVED argument rather than answering one list for every
  // call: the whole of the Archived toggle is that the two reads return disjoint sets, and a mock
  // that ignored the flag would make the toggle look like it worked whatever the code sent.
  list.mockImplementation(async (_projectId: string, _pageSize: number, wantArchived: boolean) => ({
    items: wantArchived ? archived : live,
    total: wantArchived ? archived.length : live.length,
  }));
  detail.mockImplementation(async (id: string) => ({
    ...roomRow(id, id === "c1" ? "Release plan" : "Runner budget"),
    scope: ["p1"],
    scopeProjects: [{ id: "p1", name: "Alpha", slug: "alpha" }],
    participants: [],
    messages: [
      {
        id: `${id}-m0`,
        seq: 0,
        role: "user",
        authorUserId: "u1",
        authorLabel: "Ada",
        content: `everything said in ${id}`,
        silenceReason: null,
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    ],
    windows: [],
  }));
  rename.mockImplementation(async (id: string, title: string) => roomRow(id, title));
  setArchived.mockImplementation(async (id: string, a: boolean) =>
    roomRow(id, "Release plan", a ? "2026-09-15T00:00:00.000Z" : null),
  );
  remove.mockResolvedValue(undefined);
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationPanel projectId="p1" onClose={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("ConversationPanel · what opening Ask agent shows", () => {
  it("opens on a new conversation and resumes none of them", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    // cm:guard the detail read is asserted NOT to have happened: a panel that resumed the most
    // recent room would render correctly and differ only in this call, which is exactly the shape
    // ISS-732 was filed about.
    expect(detail).not.toHaveBeenCalled();
    expect(screen.getByTestId("composer")).toBeInTheDocument();
  });

  it("shows the project's earlier conversations in that new conversation's body", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "Open Release plan in Alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Runner budget in Alpha" })).toBeInTheDocument();
  });

  it("asks the server only for the live rooms until the archived side is asked for", async () => {
    mount();
    await screen.findByRole("button", { name: "Open Release plan in Alpha" });
    expect(list).toHaveBeenCalledWith("p1", 50, false);
  });
});

describe("ConversationPanel · the way into the list, and back out", () => {
  it("carries a labelled control that opens the list from an open conversation", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Runner budget in Alpha" })).toBeInTheDocument();
  });

  it("loads the whole stored thread of the conversation that was chosen", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    expect(await screen.findByText("everything said in c1")).toBeInTheDocument();
    expect(detail).toHaveBeenCalledWith("c1");
  });

  it("keeps that conversation open until another is picked", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Runner budget in Alpha" }));
    expect(await screen.findByText("everything said in c2")).toBeInTheDocument();
  });

  it("drops back to a new conversation when the new-conversation control is used", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(screen.queryByText("everything said in c1")).not.toBeInTheDocument();
  });
});

describe("ConversationPanel · managing a room from the list", () => {
  it("sends the typed name to the rename call", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Release plan" }));
    const field = screen.getByLabelText("Conversation name");
    fireEvent.change(field, { target: { value: "Release plan v2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(rename).toHaveBeenCalledWith("c1", "Release plan v2"));
  });

  it("archives a room from its row", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Archive Release plan" }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith("c1", true));
  });

  it("shows the archived rooms, and only those, behind the Archived control", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Archived" }));
    expect(await screen.findByRole("button", { name: "Open Old migration in Alpha" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open Release plan in Alpha" })).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith("p1", 50, true);
  });

  it("offers the way back out of the archive on an archived row", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Archived" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unarchive Old migration" }));
    await waitFor(() => expect(setArchived).toHaveBeenCalledWith("c3", false));
  });

  // cm:guard the delete is asserted NOT to have been called before the confirmation is answered:
  // the row and the call are one click apart, and a confirm dialogue that rendered after the
  // request went out would be a prompt about something already gone.
  it("asks before it deletes, and does not delete until it is answered", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Release plan" }));
    expect(await screen.findByText(/will be gone/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("c1"));
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Delete Release plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText(/will be gone/)).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
  });

  // cm:guard the panel is asserted to LEAVE the room it was showing, because the alternative is the
  // quietest failure here: the thread stays on screen, reads as open, and is a room the list no
  // longer offers and the server no longer has.
  it("leaves a conversation it had open once that conversation is deleted", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Release plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
    expect(screen.queryByText("everything said in c1")).not.toBeInTheDocument();
  });

  it("leaves a conversation it had open once that conversation is archived", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive Release plan" }));

    expect(await screen.findByRole("heading", { name: "New conversation" })).toBeInTheDocument();
  });
});

// cm:guard the three cases below are the review's F1, F2 and F3. Each is a defect that leaves the
// screen looking like it worked: a room the person did not choose, a room they are told is gone and
// is not, and a room they cannot get out of.
describe("ConversationPanel \u00b7 what a slow or failing request must not do", () => {
  it("does not jump to the room a draft opened after the person had already moved on", async () => {
    let settle: (row: unknown) => void = () => undefined;
    openRoom.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );

    mount();
    // A draft's first send, still opening its room.
    fireEvent.click(await screen.findByTestId("composer"));
    await waitFor(() => expect(openRoom).toHaveBeenCalledTimes(1));

    // cm:guard the way back to the list is the HEADER control here, not the draft's inline list.
    // Since ISS-1031 a sent message shows in the thread the moment it is typed, so the empty state
    // the inline list hangs off is gone by this point — a screen saying "Start a conversation"
    // underneath the question somebody just asked is the contradiction that change removed. The
    // property this case guards is unchanged: the draft's room must not take the screen.
    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    // The person gives up waiting and opens an earlier conversation instead.
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    // The draft's room finally arrives, and its send runs. It must not take the screen.
    settle(roomRow("cNew", "Brand new"));
    // cm:guard the assertion waits for the SEND, which is the step after the callback this guards:
    // asserting straight after `settle` passes whatever the panel does, because the callback has not
    // run yet and the screen still holds the room the person chose.
    // cm:guard the third argument is the MODE, and it rides the first send of a room and no other:
    // a draft's own first message is what settles it, so the call that opens the room carries it.
    await waitFor(() => expect(sendMsg).toHaveBeenCalledWith("cNew", "hello", "assistant"));
    expect(detail).not.toHaveBeenCalledWith("cNew");
    expect(screen.getByText("everything said in c1")).toBeInTheDocument();
  });

  it("keeps the open conversation when the archive it asked for is refused", async () => {
    setArchived.mockRejectedValue(new Error("no"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));
    await screen.findByText("everything said in c1");

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));
    fireEvent.click(await screen.findByRole("button", { name: "Archive Release plan" }));
    await waitFor(() => expect(setArchived).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(await screen.findByText("everything said in c1")).toBeInTheDocument();
  });

  it("keeps the way out of a conversation whose own read fails", async () => {
    detail.mockRejectedValue(new Error("gone"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Open Release plan in Alpha" }));

    expect(await screen.findByText("Couldn't load this conversation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Conversation history" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New conversation" })).toBeInTheDocument();
  });
});
