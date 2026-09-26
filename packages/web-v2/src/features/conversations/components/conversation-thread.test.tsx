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

  it("names the account when the transport labelled nobody", () => {
    render(<ConversationThread messages={[said({ authorLabel: null })]} windows={[]} />);
    expect(screen.getByTestId("message-actions")).toHaveTextContent("You");
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
