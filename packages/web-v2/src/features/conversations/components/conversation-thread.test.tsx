// @vitest-environment jsdom
//
// ISS-1004 criterion 28, on the screen rather than in the deriver: a person
// reading a conversation can tell a turn that said nothing from a turn that was
// never taken. `types.test.ts` proves the two produce different entries; this
// proves the two entries reach the page as different text, which is where the
// criterion's own word "reading" puts it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

expect.extend(matchers);
afterEach(cleanup);

const asked: ConversationMessage = {
  id: "m0",
  seq: 0,
  role: "user",
  authorUserId: "alice",
  authorLabel: "Alice",
  content: "is the release ready?",
  silenceReason: null,
  createdAt: "2026-09-14T00:00:00.000Z",
};

const closed = (decision: ConversationWindow["decision"]): ConversationWindow => ({
  id: "w1",
  firstSeq: 0,
  lastSeq: 0,
  closedAt: "2026-09-14T00:00:01.000Z",
  decision,
  decisionDetail: null,
});

describe("ConversationThread", () => {
  it("shows what was said", () => {
    render(<ConversationThread messages={[asked]} windows={[]} />);
    expect(screen.getByText("is the release ready?")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("names the reason a settled turn said nothing", () => {
    render(<ConversationThread messages={[asked]} windows={[closed("guard-dormant")]} />);
    const silence = screen.getByTestId("thread-silence");
    expect(silence).toHaveTextContent(/no person has spoken here for a long time/i);
    expect(silence).toHaveTextContent("guard-dormant");
    expect(screen.queryByTestId("thread-pending")).toBeNull();
  });

  it("says a turn has not been taken, in different words and a different element", () => {
    render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
      />,
    );
    expect(screen.getByTestId("thread-pending")).toHaveTextContent(/nobody has answered this yet/i);
    expect(screen.queryByTestId("thread-silence")).toBeNull();
  });

  it("renders a recorded silence as a silence rather than an empty bubble", () => {
    render(
      <ConversationThread
        messages={[
          asked,
          { ...asked, id: "m1", seq: 1, role: "assistant", content: "", silenceReason: "nothing-to-say", authorLabel: null },
        ]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByText(/The agent said nothing here/)).toBeInTheDocument();
  });

  it("renders a system row as one muted line, not as an assistant bubble", () => {
    const joined: ConversationMessage = {
      ...asked,
      id: "m9",
      seq: 9,
      role: "system",
      authorUserId: null,
      authorLabel: "system",
      content: "bob@example.com joined; this room is now a group.",
    };
    render(<ConversationThread messages={[asked, joined]} windows={[]} />);
    const line = screen.getByTestId("thread-system");
    expect(line).toHaveTextContent("bob@example.com joined; this room is now a group.");
    expect(line.tagName).toBe("P");
    expect(line.closest("[class*='rounded-lg']")).toBeNull();
  });
});
