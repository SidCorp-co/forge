// @vitest-environment jsdom
//
// ISS-1004 criterion 28, on the screen rather than in the deriver: a person
// reading a conversation can tell a turn that said nothing from a turn that was
// never taken. `types.test.ts` proves the two produce different entries; this
// proves the two entries reach the page as different text, which is where the
// criterion's own word "reading" puts it.

import { Conversation } from "@/features/session/components/conversation";
import { type CanonicalBlock, type MessageEntry, parseMessages } from "@/features/session/types";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentTurn,
  ConversationMessage,
  ConversationProgressEntry,
  ConversationWindow,
} from "../types";
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

  // cm:guard a message row carrying `silence_reason` is a turn that RAN and declined, and it is a THIRD state beside the two above — the window may well be `answered`, because the silence itself was the answer. Rendering it as an empty assistant bubble is how it used to be invisible.
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

  // cm:guard asserted by test id AND by the absence of the assistant renderer's text: a system line that came out as a bubble would still contain the text, so the text alone proves nothing (ISS-1034 criterion 48).
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

  // cm:guard ISS-1039 criteria 19 to 22 — a runner-hosted turn is four different things on screen,
  // and the two that owe the person something are `failed` and only `failed`: which failure it was,
  // and what to do about it. A single grey line reading "agent" for all four is the blank thread
  // this feature exists to remove, and it passes any assertion made on the test id alone — so each
  // case here reads the SENTENCE.
  describe("a turn handed to a paired box", () => {
    const handed: ConversationWindow = { ...closed("handed-off") };
    const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({
      windowId: "w1",
      sessionId: "s1",
      state: "dispatched",
      reason: null,
      ...over,
    });

    it("says a dispatched turn is waiting to be picked up", () => {
      render(
        <ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn()]} />,
      );
      const row = screen.getByTestId("thread-agent-turn");
      expect(row).toHaveAttribute("data-agent-turn-state", "dispatched");
      expect(row).toHaveTextContent(/waiting for one to pick it up/);
    });

    it("says a running turn is being worked on, in different words", () => {
      render(
        <ConversationThread
          messages={[asked]}
          windows={[handed]}
          agentTurns={[turn({ state: "running" })]}
        />,
      );
      const row = screen.getByTestId("thread-agent-turn");
      expect(row).toHaveAttribute("data-agent-turn-state", "running");
      expect(row).toHaveTextContent(/A session is working on this/);
      expect(row).not.toHaveTextContent(/waiting for one to pick it up/);
    });

    it("shows a delivered turn as its reply and not as a label saying one arrived", () => {
      render(
        <ConversationThread
          messages={[
            asked,
            {
              ...asked,
              id: "m1",
              seq: 1,
              role: "assistant",
              authorUserId: null,
              authorLabel: null,
              content: "two issues left",
            },
          ]}
          windows={[handed]}
          agentTurns={[turn({ state: "delivered" })]}
        />,
      );
      expect(screen.queryByTestId("thread-agent-turn")).not.toBeInTheDocument();
      expect(screen.getByText("two issues left")).toBeInTheDocument();
    });

    it("tells a failed turn which failure it was, and what to do next", () => {
      render(
        <ConversationThread
          messages={[asked]}
          windows={[handed]}
          agentTurns={[
            turn({ state: "failed", reason: "the session ended before it answered" }),
          ]}
        />,
      );
      const row = screen.getByTestId("thread-agent-turn");
      expect(row).toHaveAttribute("data-agent-turn-state", "failed");
      expect(row).toHaveTextContent("the session ended before it answered");
      expect(row).toHaveTextContent(/Ask again to start a fresh session/);
    });

    // cm:guard the one sentence this thread must NEVER print over a live turn: "sent and never
    // confirmed" is what a `handed-off` window read as before it had a branch of its own, and it
    // tells a person their answer is lost while a box is still working on it (criterion 27).
    it("never reads a live turn as a reply that was sent and never confirmed", () => {
      for (const state of ["dispatched", "running", "failed"] as const) {
        cleanup();
        render(
          <ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn({ state })]} />,
        );
        expect(screen.queryByText(/sent and never confirmed/)).toBeNull();
      }
    });
  });
});

// cm:guard ISS-1078 criteria 10, 11, 12, 13, 15 and 19. Each case here asserts on the BLOCKS reaching
// the screen and not on the thread's own markup, because the whole of what this change did to this
// file is stop composing its own paragraph and hand the canonical entry to the renderer a runner
// session uses — a case that asserted the text alone would pass against either.
describe("ConversationThread \u00b7 the canonical entry, drawn (ISS-1078)", () => {
  const replied = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
    ...asked,
    id: "m1",
    seq: 1,
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content: "two issues left",
    createdAt: "2026-09-14T00:00:01.000Z",
    ...over,
  });

  const toolBlocks: CanonicalBlock[] = [
    { type: "text", text: "let me look" },
    {
      type: "tool",
      toolCall: {
        id: "t1",
        name: "Read",
        input: { file_path: "release.md" },
        result: "three issues, one blocked",
      },
    },
    { type: "text", text: "two issues left" },
  ];

  const live = (over: Partial<ConversationProgressEntry> = {}): ConversationProgressEntry => ({
    conversationId: "c1",
    rev: 4,
    entry: {
      id: "m1",
      type: "assistant",
      timestamp: Date.parse("2026-09-14T00:00:01.000Z"),
      content: "two issues left",
      blocks: toolBlocks,
    },
    ...over,
  });

  // criterion 19, and criterion 10 for the row it stores: the blocks are in the payload either way,
  // and before this change the thread printed `content` and dropped them.
  it("draws a stored turn's tool card from the blocks its payload already carried", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: toolBlocks })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByText("Read release.md")).toBeInTheDocument();
    // cm:guard the output is one click away rather than inline since ISS-1083 — the card summarizes
    // what came back and opens onto it — so this asserts the same property through the new
    // affordance rather than being dropped: the stored block's OUTPUT reaches the screen.
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Text · 25 characters");
    fireEvent.click(screen.getByTestId("tool-result-toggle"));
    expect(screen.getByTestId("tool-result-body")).toHaveTextContent("three issues, one blocked");
    // cm:guard the text either SIDE of the tool call, in order: a renderer that appended the cards
    // after the prose would satisfy an assertion on the card alone while losing what ISS-348 fixed.
    expect(screen.getByText("let me look")).toBeInTheDocument();
    expect(screen.getByText("two issues left")).toBeInTheDocument();
  });

  // ISS-1079 criterion 8 — a stored turn's reasoning, off the row alone with no socket involved.
  // This is the whole path: the blocks column, `asBlocks` on the way out of core, `parseMessages`
  // here, and the line on the page.
  it("draws a stored turn's reasoning from the blocks its payload carried", () => {
    const withThinking: CanonicalBlock[] = [
      { type: "thinking", thinking: "the release note is the gate", durationMs: 1_400 },
      { type: "text", text: "two issues left" },
    ];
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: withThinking })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByTestId("thinking-line")).toHaveTextContent("Thought for 1.4s");
    expect(screen.getByText("two issues left")).toBeInTheDocument();
    // cm:guard collapsed, so the reasoning is not on the page until a person asks for it: a turn
    // that thought for a page and answered in a line must not read as a page of answer.
    expect(screen.queryByText("the release note is the gate")).toBeNull();
  });

  // ISS-1079 criterion 5, and the web half of the round trip the whole-set read asked for: an
  // encrypted pause reaches a REOPENED room off the stored blocks alone, and offers nothing to open.
  // Before the correction this state lived on the live entry's `thinkingCount`, which the durable
  // row has no column for — so the line was true for four seconds and gone on every reload.
  it("draws a stored encrypted pause as a line with nothing to open", () => {
    const encrypted: CanonicalBlock[] = [{ type: "thinking" }, { type: "text", text: "two issues left" }];
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: encrypted })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByTestId("thinking-line")).toHaveTextContent("Thought");
    expect(screen.queryByTestId("thinking-line-toggle")).toBeNull();
    expect(screen.getByText("two issues left")).toBeInTheDocument();
  });

  // ISS-1079 criterion 4 — the absence is the assertion. A renderer that drew an empty line for
  // every turn would pass every case above.
  it("draws no thinking line for a stored turn that did not pause", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: toolBlocks })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.queryByTestId("thinking-line")).toBeNull();
  });

  // criterion 12 — every row stored before this change has `blocks` null, and they are most of them.
  it("renders a stored turn whose blocks is null as its text", () => {
    render(
      <ConversationThread messages={[asked, replied({ blocks: null })]} windows={[closed("answered")]} />,
    );
    expect(screen.getByText("two issues left")).toBeInTheDocument();
    expect(screen.queryByTestId("thread-silence")).toBeNull();
  });

  // criterion 13 — asserted as the session renderer's own markup appearing VERBATIM inside the
  // thread's, which is the only assertion that fails if the thread ever grows a second renderer that
  // merely resembles it.
  it("renders one canonical entry exactly as a runner session renders it", () => {
    const message = replied({ blocks: toolBlocks });
    const { container: mine } = render(<ConversationThread messages={[message]} windows={[]} />);
    const thread = mine.innerHTML;
    cleanup();

    const entry: MessageEntry = {
      id: message.id,
      type: "assistant",
      timestamp: Date.parse(message.createdAt),
      content: message.content,
      blocks: toolBlocks,
    };
    const { container: theirs } = render(<Conversation items={parseMessages([entry])} readOnly />);
    expect(thread).toContain(theirs.innerHTML);
  });

  // criterion 7, the half a test can hold: the caret is the session renderer's `forge-caret`, so a
  // thread that drew its own would pass an assertion made on a test id of its own and lose the
  // shared behaviour criterion 13 is about.
  it("trails a live turn with a caret and stops once the row is stored", () => {
    const { container } = render(
      <ConversationThread messages={[asked]} windows={[]} progress={live()} />,
    );
    expect(screen.getByTestId("thread-live-turn")).toBeInTheDocument();
    expect(container.querySelector(".forge-caret")).not.toBeNull();
    cleanup();

    render(
      <ConversationThread
        messages={[asked, replied({ blocks: toolBlocks })]}
        windows={[closed("answered")]}
      />,
    );
    expect(document.querySelector(".forge-caret")).toBeNull();
  });

  // criterion 8 — the refusal is DRAWN, with the draft named in it, and the replacement is no longer
  // carrying a caret because it is not being typed.
  it("shows a refused draft as withdrawn, with the replacement beside it", () => {
    const { container } = render(
      <ConversationThread
        messages={[asked]}
        windows={[]}
        progress={live({ replaced: { draft: "ship it, nothing is blocked" } })}
        withdrawn={{ m1: "ship it, nothing is blocked" }}
      />,
    );
    const withdrawn = screen.getByTestId("thread-reply-withdrawn");
    expect(withdrawn).toHaveTextContent("ship it, nothing is blocked");
    expect(withdrawn).toHaveTextContent(/did not pass the reply check/);
    expect(screen.getByText("two issues left")).toBeInTheDocument();
    expect(container.querySelector(".forge-caret")).toBeNull();
  });

  // cm:guard the case the marker was BUILT wrong for, watched in Chrome on a local walk 2026-09-17:
  // `conversation.settled` clears the progress key within a few milliseconds of the correction frame,
  // so a marker drawn off `progress.replaced` alone was on screen for 13 ms and then gone. It has to
  // survive the handover to the stored row, which is what keying it by entry id buys.
  it("keeps the withdrawal beside the stored row once the turn has settled", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: null })]}
        windows={[closed("answered")]}
        withdrawn={{ m1: "ship it, nothing is blocked" }}
      />,
    );
    expect(screen.queryByTestId("thread-live-turn")).toBeNull();
    const withdrawn = screen.getByTestId("thread-reply-withdrawn");
    expect(withdrawn).toHaveTextContent("ship it, nothing is blocked");
    expect(screen.getByText("two issues left")).toBeInTheDocument();
  });

  // cm:guard keyed by ENTRY ID, so a room that has held two corrected turns marks each beside its own
  // — a single sticky flag would print the newest draft above every one of them.
  it("marks only the turn the draft was withdrawn from", () => {
    render(
      <ConversationThread
        messages={[
          asked,
          replied({ id: "m1", content: "two issues left", blocks: null }),
          replied({ id: "m2", seq: 2, content: "and one is blocked", blocks: null }),
        ]}
        windows={[closed("answered")]}
        withdrawn={{ m2: "nothing at all is blocked" }}
      />,
    );
    const marks = screen.getAllByTestId("thread-reply-withdrawn");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("nothing at all is blocked");
  });

  // criterion 11 — the settle clears the progress key, but a `conversation.message` frame landing
  // first writes the durable row while the frames are still in the cache, and the answer would be on
  // the screen twice for as long as that gap lasts.
  it("reduces a turn's frames and its durable row to exactly one rendered turn", () => {
    const message = replied({ blocks: toolBlocks });
    render(
      <ConversationThread
        messages={[asked, message]}
        windows={[closed("answered")]}
        progress={live()}
      />,
    );
    expect(screen.getAllByText("two issues left")).toHaveLength(1);
    expect(screen.getAllByText("Read release.md")).toHaveLength(1);
    expect(screen.queryByTestId("thread-live-turn")).toBeNull();
  });

  // cm:guard the reduction is by ENTRY ID and by nothing else, which is why the two turns here say
  // exactly the SAME thing under different ids: asked twice and answered twice is two answers, and a
  // reduction on text would silently draw the second turn as one — the identical fixture is the only
  // one that can tell the two rules apart.
  it("keeps a live turn that is not the stored row's turn, even saying the same thing", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ id: "m1", content: "two issues left", blocks: null })]}
        windows={[closed("answered")]}
        progress={live({
          entry: { id: "m2", type: "assistant", timestamp: 0, content: "two issues left" },
        })}
      />,
    );
    expect(screen.getByTestId("thread-live-turn")).toBeInTheDocument();
    expect(screen.getAllByText("two issues left")).toHaveLength(2);
  });

  // criterion 15 — the three readings a room in flight has to keep apart. Rendered three times in one
  // case because the property is that they DIFFER: each asserted alone passes against a thread that
  // prints the same sentence for all three.
  describe("nobody has answered, the agent had nothing to add, and an answer arriving", () => {
    const openWindow: ConversationWindow = { ...closed(null), closedAt: null };

    it("says nobody has answered yet while nothing is arriving", () => {
      render(<ConversationThread messages={[asked]} windows={[openWindow]} />);
      expect(screen.getByTestId("thread-pending")).toHaveTextContent(/nobody has answered this yet/i);
      expect(screen.queryByTestId("thread-live-turn")).toBeNull();
    });

    it("says the agent read it and had nothing to add, in different words", () => {
      render(
        <ConversationThread
          messages={[asked, replied({ content: "", silenceReason: "nothing-to-say", blocks: null })]}
          windows={[closed("answered")]}
        />,
      );
      expect(screen.getByText(/The agent said nothing here/)).toBeInTheDocument();
      expect(screen.queryByTestId("thread-pending")).toBeNull();
      expect(screen.queryByTestId("thread-live-turn")).toBeNull();
    });

    // cm:guard the window is STILL OPEN here, because that is what a room read mid-turn holds: the
    // collector closes it when the turn ends. A thread that answered an open window with "nobody has
    // answered this yet" regardless would print that line directly above the answer being typed.
    it("shows the answer arriving and stops saying nobody has answered", () => {
      render(<ConversationThread messages={[asked]} windows={[openWindow]} progress={live()} />);
      expect(screen.getByTestId("thread-live-turn")).toBeInTheDocument();
      expect(screen.getByText("two issues left")).toBeInTheDocument();
      expect(screen.queryByTestId("thread-pending")).toBeNull();
    });
  });
});

// cm:guard the compounding defect could only be seen through BOTH components at once: each file's
// cap was correct on its own, and nested they multiplied to 0.85 x 0.85 = 0.7225 — a turn got 72%
// of the panel. `conversation-width.test.tsx` counts the caps inside the shared renderer; this one
// counts them through the wrapper, which is the render a person was actually looking at (ISS-1083).
describe("the assistant column, drawn through the chat wrapper", () => {
  const answered: ConversationMessage = {
    id: "m1",
    seq: 1,
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content: "Two issues are left.",
    silenceReason: null,
    createdAt: "2026-09-14T00:00:02.000Z",
  };

  it("carries exactly one restricting max-width, not one per component", () => {
    const { container } = render(<ConversationThread messages={[asked, answered]} windows={[]} />);
    const capped = Array.from(container.querySelectorAll<HTMLElement>("*"))
      .map((el) => el.getAttribute("class") ?? "")
      .filter((cls) => /(?:^|\s)(?:sm:)?max-w-\[/.test(cls));
    // One for the person's bubble, one for the assistant column. Never two for either.
    expect(capped).toHaveLength(2);
    expect(capped.filter((c) => c.includes("max-w-[72ch]"))).toHaveLength(1);
    expect(capped.filter((c) => c.includes("max-w-[88%]"))).toHaveLength(1);
    for (const cls of capped) expect(cls).not.toContain("sm:max-w-");
  });
});

// cm:guard the wire's OWN shape, end to end, because the unit tests around `summarizeResult` fed it
// objects and every real path hands it a string: the accumulator writes
// `JSON.stringify(ev.result ?? '')` into `output` and the CLI path lifts the stream-json result's
// text. A summary that met only objects read `Text · N characters` on every card in the product
// while 31 assertions stayed green (ISS-1083, implementation consult F1).
describe("a tool's output as the wire actually carries it", () => {
  const replied = (over: Partial<ConversationMessage> = {}): ConversationMessage => ({
    ...asked,
    id: "m1",
    seq: 1,
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content: "two issues left",
    createdAt: "2026-09-14T00:00:01.000Z",
    ...over,
  });

  const withOutput = (output: string): CanonicalBlock[] => [
    { type: "tool", toolCall: { id: "t9", name: "forge_projects_get", input: { slug: "erp" }, output } },
  ];

  it("summarizes a serialized object as the object, and opens onto it pretty-printed", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: withOutput('{"project":{"slug":"erp"}}') })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Object · 1 field");
    fireEvent.click(screen.getByTestId("tool-result-toggle"));
    expect(screen.getByTestId("tool-result-body").textContent).toContain('\n  "project"');
  });

  it("summarizes a serialized empty array as an empty array", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: withOutput("[]") })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Array · 0 items");
  });

  it("summarizes what the accumulator writes for a null result as no result", () => {
    render(
      <ConversationThread
        messages={[asked, replied({ blocks: withOutput('""') })]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("No result");
    expect(screen.queryByTestId("tool-result-toggle")).toBeNull();
  });
});

// cm:guard THE moment this store exists for (ISS-1083 criterion 24): a turn settling on this
// surface is not a re-render, it is a SWAP — `threadEntries` stops emitting the `progress` entry and
// emits a `said` row instead, so React unmounts `LiveTurn` and mounts `Said` at that position. A
// tool result a reader had opened while the answer was arriving used to go with it, and no key
// inside the turn survives that, because the component at the position changes type. The scope on
// `ConversationThread` does.
describe("what a reader has opened, across the settle", () => {
  const blocks: CanonicalBlock[] = [
    { type: "text", text: "let me look" },
    {
      type: "tool",
      toolCall: { id: "t1", name: "Read", input: { file_path: "release.md" }, output: '{"open":3}' },
    },
    { type: "text", text: "two issues left" },
  ];

  // The id is the SAME on both sides, which is the store's own premise: a progress entry carries
  // "the id the settled row will carry" and `parseMessages` passes it straight through.
  const arriving: ConversationProgressEntry = {
    conversationId: "c1",
    rev: 4,
    entry: {
      id: "m1",
      type: "assistant",
      timestamp: Date.parse("2026-09-14T00:00:01.000Z"),
      content: "two issues left",
      blocks,
    },
  };
  const stored: ConversationMessage = {
    ...asked,
    id: "m1",
    seq: 1,
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content: "two issues left",
    createdAt: "2026-09-14T00:00:01.000Z",
    blocks,
  };

  it("keeps a tool result open when the turn it is in settles", () => {
    const { rerender } = render(
      <ConversationThread messages={[asked]} windows={[]} progress={arriving} />,
    );
    fireEvent.click(screen.getByTestId("tool-result-toggle"));
    expect(screen.getByTestId("tool-result-body")).toHaveTextContent('"open": 3');

    // The turn settles: the stored row lands and the frames stop being a turn of their own.
    rerender(
      <ConversationThread messages={[asked, stored]} windows={[closed("answered")]} progress={null} />,
    );

    expect(screen.queryByTestId("thread-live-turn")).toBeNull();
    expect(screen.getByTestId("tool-result-body")).toHaveTextContent('"open": 3');
  });

  // cm:guard and it was CLOSED before the settle, so what survives is the reader's decision either
  // way rather than a card that happens to default open. Without this the case above would pass
  // against an implementation that opened every card on a settled row.
  it("keeps a tool result closed when the reader never opened it", () => {
    const { rerender } = render(
      <ConversationThread messages={[asked]} windows={[]} progress={arriving} />,
    );
    rerender(
      <ConversationThread messages={[asked, stored]} windows={[closed("answered")]} progress={null} />,
    );
    expect(screen.queryByTestId("tool-result-body")).toBeNull();
    expect(screen.getByTestId("tool-result-summary")).toHaveTextContent("Object · 1 field");
  });
});
