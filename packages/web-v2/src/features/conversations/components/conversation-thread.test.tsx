// @vitest-environment jsdom
//
// ISS-1146 — what a reader can do with a turn that is already in the log:
// read who said it and when, take its text, see what was sent with it, and
// tell a turn somebody stopped from one the agent had nothing to add to.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

expect.extend(matchers);
afterEach(cleanup);
const reader = vi.hoisted(() => ({ id: "me" }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: reader.id } }) }));

const AT = "2026-09-21T10:14:38.790Z";

function said(over: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "m1",
    seq: 0,
    role: "user",
    authorUserId: "u1",
    authorLabel: "Colin",
    content: "what is in this picture",
    silenceReason: null,
    createdAt: AT,
    ...over,
  };
}

function window(over: Partial<ConversationWindow> = {}): ConversationWindow {
  return {
    id: "w1",
    firstSeq: 0,
    lastSeq: 0,
    closedAt: AT,
    decision: "stopped",
    decisionDetail: null,
    ...over,
  };
}

describe("what a stored turn carries for its reader", () => {
  it("says who said it", () => {
    render(<ConversationThread messages={[said()]} windows={[]} />);
    expect(screen.getByTestId("message-actions")).toHaveTextContent("Colin");
  });

  // ISS-1229 r25: a message core could not name read "You" to everyone; "You" is the reader's word alone.
  // r48 (the master's ruling on judge-142): an unnamed sender signs "A member".
  it("signs A member where nobody is named, never You", () => {
    render(<ConversationThread messages={[said({ authorLabel: null })]} windows={[]} />);
    expect(screen.getByTestId("message-actions").querySelector("span")?.textContent).toBe("A member");
    expect(screen.getByTestId("message-actions")).not.toHaveTextContent("You");
  });

  // ISS-1229 r25, judge-72: every person's bubble was right-aligned and orange, so only the caption
  // told the reader's own line from a teammate's.
  it("draws the reader's own turn on the right in the accent, and another's on the left in a neutral tone", () => {
    render(
      <ConversationThread
        messages={[said({ id: "m1", authorUserId: "me" }), said({ id: "m2", seq: 1, authorUserId: "u2", authorLabel: "Mai Tran" })]}
        windows={[]}
      />,
    );
    const mine = screen.getByTestId("said-by-you");
    const theirs = screen.getByTestId("said-by-another");
    expect(mine.className).toContain("items-end");
    expect(mine.querySelector(".bg-accent")).not.toBeNull();
    expect(theirs.className).toContain("items-start");
    expect(theirs.querySelector(".bg-accent")).toBeNull();
    expect(theirs.querySelector(".bg-surface")).not.toBeNull();
    expect(theirs).toHaveTextContent("Mai Tran");
  });

  // ISS-1229 r24: the reader's own message, in a room where core labels them like anyone else.
  it('heads the reader\'s own message "You", whatever label core stored', () => {
    render(<ConversationThread messages={[said({ authorUserId: "me", authorLabel: "Another member" })]} windows={[]} />);
    expect(screen.getByTestId("message-actions")).toHaveTextContent("You");
    expect(screen.getByTestId("message-actions")).not.toHaveTextContent("Another member");
    expect(screen.getByRole("button", { name: /^Copy message from you/ })).toBeInTheDocument();
  });

  it("says when it was said, with the full stamp behind it", () => {
    render(<ConversationThread messages={[said()]} windows={[]} />);
    const when = screen.getByTestId("message-actions").querySelector("time");
    expect(when).toHaveAttribute("dateTime", AT);
    expect(when?.getAttribute("title")).toBeTruthy();
  });

  it("copies the turn's text, and says it did", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ConversationThread messages={[said()]} windows={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /^Copy message from Colin/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("what is in this picture"));
    expect(await screen.findByRole("button", { name: /^Copied message from Colin/ })).toBeInTheDocument();
  });

  // ISS-1229 r22: the control's name is a sentence, so a person with no display name reads lower-case in it.
  it("names an unnamed author lower-case inside the copy control's name", () => {
    render(<ConversationThread messages={[said({ authorLabel: "Another member" })]} windows={[]} />);
    expect(screen.getByTestId("message-actions").querySelector("span")?.textContent).toBe("A member");
    expect(screen.getByRole("button", { name: /^Copy message from a member/ })).toBeInTheDocument();
  });

  it("says which message each copy control takes, so a list of them is not seven 'Copy's", () => {
    const answer = said({
      id: "m2",
      seq: 1,
      role: "assistant",
      authorUserId: null,
      authorLabel: null,
      content: "a cat",
    });
    render(<ConversationThread messages={[said(), answer]} windows={[]} />);
    const names = screen
      .getAllByRole("button", { name: /^Copy/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names[0]).toMatch(/^Copy message from Colin at /);
    expect(names[1]).toMatch(/^Copy message from Assistant at /);
  });

  it("shows the files that went with it", () => {
    const withFile = said({
      images: [{ name: "shot.png", mime: "image/png", ref: "/api/x/1/download" }],
    });
    render(<ConversationThread messages={[withFile]} windows={[]} />);
    expect(screen.getByTestId("message-files")).toHaveTextContent("shot.png");
  });

  it("draws no empty bubble for a turn that was a picture alone", () => {
    const pictureOnly = said({
      content: "",
      images: [{ name: "shot.png", mime: "image/png", ref: "/api/x/1/download" }],
    });
    render(<ConversationThread messages={[pictureOnly]} windows={[]} />);
    expect(screen.getByTestId("message-files")).toBeInTheDocument();
    expect(screen.queryByText("what is in this picture")).not.toBeInTheDocument();
  });
});

describe("a message still on its way", () => {
  const png = new File(["x"], "whiteboard.png", { type: "image/png" });

  it("shows the files it carries while it is sending", () => {
    render(
      <ConversationThread
        messages={[]}
        windows={[]}
        outbox={[{ id: "o1", content: "read this", files: [png], state: "sending" }]}
      />,
    );
    expect(screen.getByTestId("thread-outbox-sending")).toHaveTextContent("Sending…");
    expect(screen.getByTestId("message-files")).toHaveTextContent("whiteboard.png");
  });

  it("draws no empty bubble for a picture sent alone", () => {
    render(
      <ConversationThread
        messages={[]}
        windows={[]}
        outbox={[{ id: "o1", content: "", files: [png], state: "queued" }]}
      />,
    );
    const item = screen.getByTestId("thread-outbox-queued");
    expect(item.querySelector("p.fg-body")).toBeNull();
    expect(screen.getByTestId("message-files")).toHaveTextContent("whiteboard.png");
  });
});

describe("a turn somebody stopped", () => {
  it("says a person stopped it", () => {
    render(<ConversationThread messages={[said()]} windows={[window()]} />);
    expect(screen.getByTestId("thread-silence")).toHaveTextContent("You stopped this answer");
  });

  it("does not read as the agent having had nothing to add", () => {
    render(<ConversationThread messages={[said()]} windows={[window()]} />);
    expect(screen.getByTestId("thread-silence")).not.toHaveTextContent("nothing to add");
  });

  it("still tells the two apart", () => {
    render(
      <ConversationThread messages={[said()]} windows={[window({ decision: "nothing-to-say" })]} />,
    );
    expect(screen.getByTestId("thread-silence")).toHaveTextContent("nothing to add");
  });
});

// ISS-1229 r40, judge-111 at abdd0d7: the reply check blocked a false reply outright (solo seq 7), and
// the room read "The agent said nothing here — screen-refused" over a window line saying the agent "had
// nothing to add" and the code "nothing-to-say".
describe("a reply the reply check withheld", () => {
  const WITHHELD = /reply was withheld: the reply check found it said something the tracker does not show/;
  const blocked = said({ id: "m2", seq: 1, role: "assistant", authorUserId: null, content: "", silenceReason: "screen-refused" });

  it("says in words that the reply was withheld and why, never a stored code", () => {
    render(<ConversationThread messages={[said(), blocked]} windows={[]} />);
    const line = screen.getByTestId("message-silence");
    expect(line).toHaveTextContent(WITHHELD);
    expect(line).not.toHaveTextContent(/screen-refused|nothing to add/);
  });

  // ISS-1229 r44, judge-124: a reply withheld outright for a credential said only that it held something the
  // tracker does not show.
  it("says a reply withheld for a credential was withheld because it looked like it held one", () => {
    const credential = { ...blocked, silenceReason: "screen-refused-credential" };
    render(
      <ConversationThread
        messages={[said(), credential]}
        windows={[window({ decision: "nothing-to-say", decisionDetail: { reason: "screen-refused-credential" } })]}
      />,
    );
    for (const line of [screen.getByTestId("message-silence"), screen.getByTestId("thread-silence")]) {
      expect(line).toHaveTextContent(
        "The agent's reply was withheld because it looked like it held a password, key or token, so nothing was posted.",
      );
      expect(line).not.toHaveTextContent(/tracker does not show|screen-refused|nothing to add/);
    }
  });

  it("reads the window it closed the same way", () => {
    render(
      <ConversationThread
        messages={[said()]}
        windows={[window({ decision: "nothing-to-say", decisionDetail: { reason: "screen-refused" } })]}
      />,
    );
    const line = screen.getByTestId("thread-silence");
    expect(line).toHaveTextContent(WITHHELD);
    expect(line).not.toHaveTextContent(/nothing-to-say|screen-refused|nothing to add/);
  });

  it("says it once where the window names the silence its turn stored", () => {
    render(
      <ConversationThread
        messages={[said(), blocked]}
        windows={[window({ decision: "nothing-to-say", decisionDetail: { reason: "screen-refused", silenceSeq: 1 } })]}
      />,
    );
    expect(screen.getAllByText(WITHHELD)).toHaveLength(1);
    expect(screen.queryByTestId("thread-silence")).toBeNull();
  });

  // Consult review F1: a message arriving while a turn runs puts the silence after it, so adjacency
  // names the wrong window; the window's own detail names its silence.
  it("keeps another window's line where a message arrived between a turn and its silence", () => {
    const second = said({ id: "m3", seq: 1, content: "and one more thing" });
    const late = { ...blocked, id: "m4", seq: 2 };
    render(
      <ConversationThread
        messages={[said(), second, late]}
        windows={[
          window({ id: "w1", firstSeq: 0, lastSeq: 0, decision: "nothing-to-say", decisionDetail: { reason: "screen-refused", silenceSeq: 2 } }),
          window({ id: "w2", firstSeq: 1, lastSeq: 1, decision: "stopped" }),
        ]}
      />,
    );
    expect(screen.getAllByText(WITHHELD)).toHaveLength(1);
    expect(screen.getByTestId("thread-silence")).toHaveTextContent("You stopped this answer");
  });

  it("still says a window's silence where it names no stored message", () => {
    render(
      <ConversationThread
        messages={[said()]}
        windows={[window({ decision: "nothing-to-say", decisionDetail: { reason: "screen-refused", silenceSeq: 9 } })]}
      />,
    );
    expect(screen.getByTestId("thread-silence")).toHaveTextContent(WITHHELD);
  });

  it("keeps 'nothing to add' for a turn that chose silence, in words", () => {
    render(<ConversationThread messages={[said(), { ...blocked, silenceReason: "nothing-to-say" }]} windows={[]} />);
    expect(screen.getByTestId("message-silence")).toHaveTextContent("The agent read this and had nothing to add.");
    expect(screen.getByTestId("message-silence")).not.toHaveTextContent("nothing-to-say");
  });

  it("says an empty reply and a turn that ended without one as what they are", () => {
    render(<ConversationThread messages={[said(), { ...blocked, silenceReason: "empty-reply" }]} windows={[]} />);
    expect(screen.getByTestId("message-silence")).toHaveTextContent("The agent's reply came back empty, so nothing was posted.");
    cleanup();
    render(<ConversationThread messages={[said(), { ...blocked, silenceReason: "gateway timed out (504)" }]} windows={[]} />);
    expect(screen.getByTestId("message-silence")).toHaveTextContent("The agent's turn ended before it wrote a reply, so nothing was posted.");
    expect(screen.getByTestId("message-silence")).not.toHaveTextContent("504");
  });
});

// ISS-1229 r34, judge-93: a room's tool cards read "forge" over "Object · 3 fields", which tells a person
// nothing. A room's turn says what its assistant did; the run thread keeps its technical cards.
describe("a tool call in a room's turn", () => {
  const turn = said({
    id: "m2",
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content: "Filed ISS-1.",
    blocks: [
      {
        type: "tool",
        toolCall: {
          id: "t1",
          name: "forge",
          input: { argv: ["issue", "--search", "invoice footer"], body: "" },
          output: JSON.stringify({ exitCode: 0, stdout: "0 issue(s) over 1 page(s)", stderr: "" }),
        },
      },
      { type: "text", text: "Filed ISS-1." },
    ],
  });

  it("says what was done, never the result's shape or the tool's stored name", () => {
    render(<ConversationThread messages={[turn]} windows={[]} />);
    const thread = screen.getByTestId("agent-turn");
    expect(thread).toHaveTextContent("Searched issues for “invoice footer” — none found");
    expect(thread).not.toHaveTextContent(/Object · \d+ fields?/);
    expect(thread.textContent).not.toMatch(/\bforge\b/);
  });
});

// ISS-1229 r38, judge-103: the assistant read a guide that does not exist, then listed the guides in the
// same reply; the refused card offered the person nothing and said nothing of the second call.
describe("a refused call the assistant put right in the same reply", () => {
  const call = (id: string, argv: string[], out: { exitCode: number; stdout: string; stderr: string }) => ({
    type: "tool" as const,
    toolCall: { id, name: "forge", input: { argv, body: "" }, output: JSON.stringify(out), ...(out.exitCode ? { isError: true } : {}) },
  });
  const noGuide = call("g1", ["guide", "issue-claiming"], {
    exitCode: 1,
    stdout: "",
    stderr: "No guide named issue-claiming. `forge guide` lists the guides this plugin stands behind.\n",
  });
  const turn = (blocks: unknown[]) =>
    said({ id: "m3", role: "assistant", authorUserId: null, authorLabel: null, content: "Here.", blocks: blocks as never });

  it("says the assistant tried another way where a later call of the same act went through", () => {
    render(
      <ConversationThread
        messages={[
          turn([
            noGuide,
            call("g2", ["guide"], { exitCode: 0, stdout: "contract\n", stderr: "" }),
            call("g3", ["guide", "issue-flow"], { exitCode: 0, stdout: "# Skill: issue-flow\n", stderr: "" }),
            { type: "text", text: "Here." },
          ]),
        ]}
        windows={[]}
      />,
    );
    expect(screen.getByTestId("room-tool-refusal")).toHaveTextContent(
      "No guide named issue-claiming. The assistant tried another way below, and its answer says how it went.",
    );
  });

  it("asks the person to have it put right where nothing later went through", () => {
    render(<ConversationThread messages={[turn([noGuide, { type: "text", text: "Here." }])]} windows={[]} />);
    expect(screen.getByTestId("room-tool-refusal")).toHaveTextContent(
      "No guide named issue-claiming. Ask the assistant to put it right and try again.",
    );
  });
});

// ISS-1229 r35, judge-95: in a room whose only agent lost its role, the sent message sat over "Nobody has
// answered this yet." as if an answer were coming, and the reason the agent cannot answer was gone.
describe("a message no agent could answer", () => {
  const lines = ["@ledger can't answer: it no longer holds a role on Ledger, and answers again once it does."];
  const lostRole = { reason: "no agent of this project holds a role on it", cause: "agent-lost-role" };

  it("names each agent that cannot answer and why under it", () => {
    render(
      <ConversationThread
        messages={[said()]}
        windows={[window({ decision: "unreachable", decisionDetail: lostRole })]}
        unanswered={lines}
      />,
    );
    expect(screen.getByTestId("thread-no-answer")).toHaveTextContent(lines[0] as string);
    expect(screen.queryByText(/could not be reached/)).toBeNull();
  });

  it("never says nobody has answered it yet while no agent can answer", () => {
    render(
      <ConversationThread
        messages={[said()]}
        windows={[window({ closedAt: null, decision: null })]}
        unanswered={lines}
      />,
    );
    expect(screen.queryByText("Nobody has answered this yet.")).toBeNull();
    expect(screen.getByTestId("thread-no-answer")).toHaveTextContent(lines[0] as string);
  });

  it("says why plainly once an agent can answer again", () => {
    render(
      <ConversationThread
        messages={[said()]}
        windows={[window({ decision: "unreachable", decisionDetail: lostRole })]}
      />,
    );
    expect(screen.getByTestId("thread-no-answer")).toHaveTextContent(
      "No agent here held a role on this room's project when this was sent, so it was never answered.",
    );
  });
});

// ISS-1229 r35, judge-95: a withdrawn draft was shown to the person, struck through, under the line
// saying it was withdrawn.
describe("a reply the reply check withdrew", () => {
  it("is said once, plainly, its text only under technical details", () => {
    render(
      <ConversationThread
        messages={[said({ id: "a1", role: "assistant", authorLabel: null, content: "The answer" })]}
        windows={[]}
        withdrawn={{ a1: { draft: "the withdrawn draft", for: null } }}
      />,
    );
    expect(screen.getByTestId("thread-reply-withdrawn")).toHaveTextContent(
      "A reply was withdrawn by the reply check and answered again below.",
    );
    expect(screen.queryByText("the withdrawn draft")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Technical details/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("the withdrawn draft")).toBeInTheDocument();
  });
});

// ISS-1229 r36, judge-97: after a reload the line was gone, because the draft lived only in the socket's
// cache; it is now stored with the reply that replaced it.
describe("a withdrawn reply read back after a reload", () => {
  it("still says once, plainly, that a reply was withdrawn, its text under technical details", () => {
    render(
      <ConversationThread
        messages={[
          said({ id: "a1", role: "assistant", authorLabel: null, content: "The answer", withdrawnDraft: "the stored draft" }),
        ]}
        windows={[]}
      />,
    );
    expect(screen.getByTestId("thread-reply-withdrawn")).toHaveTextContent(
      "A reply was withdrawn by the reply check and answered again below.",
    );
    expect(screen.queryByText("the stored draft")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Technical details/ }));
    expect(screen.getByText("the stored draft")).toBeInTheDocument();
  });

  // r37, judge-100: the withdrawn text showed its markdown as raw asterisks.
  it("shows the withdrawn text rendered, never its raw markup", () => {
    render(
      <ConversationThread
        messages={[
          said({ id: "a1", role: "assistant", authorLabel: null, content: "The answer", withdrawnDraft: "**ISS-999** is not on this project's tracker." }),
        ]}
        windows={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Technical details/ }));
    const draft = screen.getByTestId("withdrawn-draft");
    expect(draft.textContent).toBe("ISS-999 is not on this project's tracker.");
    expect(draft.querySelector("strong")?.textContent).toBe("ISS-999");
  });

  // ISS-1229 r43, judge-120: a draft withdrawn for holding a token-looking URL was kept whole and shown
  // under its technical details.
  it("says why a draft that looked like it held a credential was withdrawn, and offers none of it", () => {
    render(
      <ConversationThread
        messages={[said({ id: "a1", role: "assistant", authorLabel: null, content: "The answer", withdrawnFor: "credential" })]}
        windows={[]}
      />,
    );
    expect(screen.getByTestId("thread-reply-withdrawn")).toHaveTextContent(
      "A reply was withdrawn by the reply check because it looked like it held a password, key or token, and answered again below.",
    );
    expect(screen.queryByRole("button", { name: /Technical details/ })).toBeNull();
  });

  it("says the same while the turn is live, from the frame that withdrew it", () => {
    render(
      <ConversationThread
        messages={[said({ id: "a1", role: "assistant", authorLabel: null, content: "The answer" })]}
        windows={[]}
        withdrawn={{ a1: { draft: null, for: "credential" } }}
      />,
    );
    expect(screen.getByTestId("thread-reply-withdrawn")).toHaveTextContent(/looked like it held a password, key or token/);
    expect(screen.queryByRole("button", { name: /Technical details/ })).toBeNull();
  });

  it("says nothing of a withdrawal for a reply the check let through", () => {
    render(<ConversationThread messages={[said({ id: "a2", role: "assistant", authorLabel: null, content: "Fine", withdrawnDraft: null })]} windows={[]} />);
    expect(screen.queryByTestId("thread-reply-withdrawn")).toBeNull();
  });
});

// ISS-1229 r43 told unnamed senders apart by when each was added; r48 (the master's ruling on judge-142):
// a message is signed with the name its sender gave or "A member", never an added date or an ordinal.
describe("who said each message in a room of people none of whom set a name", () => {
  const person = (id: string, userId: string, addedAt: string, displayName: string | null = null) => ({
    id,
    kind: "person" as const,
    userId,
    projectId: null,
    label: null,
    displayName,
    reachable: null,
    addedAt,
  });
  const participants = [
    person("pm", "me", "2026-10-26T03:30:00.000Z"),
    person("p2", "u2", "2026-10-26T03:30:00.000Z"),
    person("p3", "u3", "2026-10-26T03:30:00.000Z"),
    person("p4", "u4", "2026-10-26T03:31:00.000Z", "Mai"),
  ];

  it("signs each unnamed person A member, a named one by their name, and the reader You", () => {
    render(
      <ConversationThread
        participants={participants}
        messages={[
          said({ id: "m1", seq: 0, authorUserId: "u2", authorLabel: "Another member" }),
          said({ id: "m2", seq: 1, authorUserId: "u3", authorLabel: "Another member" }),
          said({ id: "m3", seq: 2, authorUserId: "me", authorLabel: "Another member" }),
          said({ id: "m4", seq: 3, authorUserId: "u4", authorLabel: "Another member" }),
        ]}
        windows={[]}
      />,
    );
    const authors = screen.getAllByTestId("message-actions").map((el) => el.querySelector("span")?.textContent);
    expect(authors).toEqual(["A member", "A member", "You", "Mai"]);
  });

  it("never signs a message with when its sender was added, or their place in that order", () => {
    render(
      <ConversationThread
        participants={participants}
        messages={[
          said({ id: "m1", seq: 0, authorUserId: "u2", authorLabel: "Another member" }),
          said({ id: "m2", seq: 1, authorUserId: "u3", authorLabel: "Another member" }),
        ]}
        windows={[]}
      />,
    );
    for (const el of screen.getAllByTestId("message-actions")) {
      expect(el.textContent).not.toMatch(/added|the first|the second/);
    }
  });

  it("keeps core's name for somebody who is no longer in the room", () => {
    render(
      <ConversationThread
        participants={participants}
        messages={[said({ id: "m1", authorUserId: "gone", authorLabel: "Lan Pham" })]}
        windows={[]}
      />,
    );
    expect(screen.getByTestId("message-actions").querySelector("span")?.textContent).toBe("Lan Pham");
  });
});
