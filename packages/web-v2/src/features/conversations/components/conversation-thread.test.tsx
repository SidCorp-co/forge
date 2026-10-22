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
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));

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
  it("names another member where nobody is named, never You", () => {
    render(<ConversationThread messages={[said({ authorLabel: null })]} windows={[]} />);
    expect(screen.getByTestId("message-actions")).toHaveTextContent("Another member");
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
    expect(screen.getByTestId("message-actions")).toHaveTextContent("Another member");
    expect(screen.getByRole("button", { name: /^Copy message from another member/ })).toBeInTheDocument();
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
        withdrawn={{ a1: "the withdrawn draft" }}
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

  it("says nothing of a withdrawal for a reply the check let through", () => {
    render(<ConversationThread messages={[said({ id: "a2", role: "assistant", authorLabel: null, content: "Fine", withdrawnDraft: null })]} windows={[]} />);
    expect(screen.queryByTestId("thread-reply-withdrawn")).toBeNull();
  });
});
