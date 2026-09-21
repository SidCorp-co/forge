// @vitest-environment jsdom
//
// ISS-1083 criteria 21–25 and 29 — history folds, and it folds only where nobody is looking.
//
// The owner's decision, 2026-09-17: collapse, but only OLDER turns. A reader who has just watched
// an answer arrive keeps every card and every pause of it; the turns above it show one row each.
//
// `fold.test.ts` holds the rule about ORDER. This file holds the three properties only a mounted
// thread can state: which turn keeps its machinery, that the row opens back onto what it took, and
// that a fold never happens under a reader who is inside the turn or reading the one above it.
//
// Matchers are extended on vitest's OWN `expect` for the reason `thinking-line.test.tsx` gives.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DisclosureScope } from "../disclosure";
import {
  type CanonicalBlock,
  type ConversationItem,
  type MessageEntry,
  type RenderBlock,
  parseMessages,
} from "../types";
import { Conversation } from "./conversation";

expect.extend(matchers);

afterEach(cleanup);

const text = (t: string): RenderBlock => ({ type: "text", text: t });
const tool = (id: string, result: unknown = { runs: [] }): RenderBlock => ({
  type: "tool",
  tool: { id, name: "forge_pipeline_runs", result, durationMs: 12 },
});

const agent = (id: string, blocks: RenderBlock[]): ConversationItem => ({
  kind: "agent",
  id,
  turnId: id,
  turnIndex: 0,
  role: "assistant",
  thinkingCount: 0,
  text: "",
  blocks,
  attachments: [],
  editedAt: null,
});

const older = agent("a1", [
  text("Let me look at the runs."),
  tool("t1"),
  tool("t2"),
  { type: "thinking", count: 2 },
  text("Two are still running."),
]);
const newest = agent("a2", [text("And this one?"), tool("t3"), text("That one finished.")]);
const newer = agent("a3", [text("Anything else?")]);

const thread = (items: ConversationItem[]) => (
  <DisclosureScope>
    <Conversation items={items} readOnly />
  </DisclosureScope>
);

const turn = (id: string) =>
  screen.getAllByTestId("agent-turn").find((el) => el.getAttribute("data-turn-id") === id) as
    | HTMLElement
    | undefined;

describe("which turn keeps its machinery", () => {
  // Criterion 21.
  it("leaves the newest turn exactly as it was", () => {
    render(thread([older, newest]));
    const t = turn("a2");
    expect(t).toBeDefined();
    expect(within(t as HTMLElement).getAllByTestId("tool-result-summary")).toHaveLength(1);
    expect(within(t as HTMLElement).queryByTestId("turn-fold")).toBeNull();
  });

  // Criterion 22, and it names what it holds: two calls and two pauses.
  it("folds an older turn's cards and pauses into one row", () => {
    render(thread([older, newest]));
    const t = turn("a1") as HTMLElement;
    expect(within(t).getByTestId("turn-fold")).toHaveTextContent("2 tool calls and 2 pauses");
    expect(within(t).queryByTestId("tool-result-summary")).toBeNull();
    expect(within(t).queryByTestId("thinking-line")).toBeNull();
  });

  it("keeps a folded turn's prose, and keeps its order", () => {
    render(thread([older, newest]));
    const t = turn("a1") as HTMLElement;
    expect(t.textContent).toContain("Let me look at the runs.");
    expect(t.textContent).toContain("Two are still running.");
    expect(t.textContent?.indexOf("Let me look")).toBeLessThan(
      t.textContent?.indexOf("Two are still") ?? -1,
    );
  });

  it("folds nothing in a thread of one turn", () => {
    render(thread([older]));
    expect(screen.queryByTestId("turn-fold")).toBeNull();
    expect(screen.getAllByTestId("tool-result-summary")).toHaveLength(2);
  });

  it("folds every turn above the newest and not just the one before it", () => {
    render(thread([older, newest, newer]));
    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
    expect(within(turn("a2") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
    expect(within(turn("a3") as HTMLElement).queryByTestId("turn-fold")).toBeNull();
  });
});

describe("the row opens back", () => {
  // Criterion 23.
  it("shows what it collapsed, in the turn's own order", () => {
    render(thread([older, newest]));
    const t = turn("a1") as HTMLElement;
    fireEvent.click(within(t).getByTestId("turn-fold"));
    expect(within(t).getAllByTestId("tool-result-summary")).toHaveLength(2);
    expect(within(t).getByTestId("thinking-line")).toBeInTheDocument();
    expect(within(t).queryByTestId("turn-fold")).toBeNull();
    // The prose is where it always was, around what came back.
    const shown = (within(t).getAllByTestId("tool-result-summary")[0] as HTMLElement).textContent;
    expect(shown).toContain("Object · 1 field");
  });

  it("leaves the other folded turns folded", () => {
    render(thread([older, newest, newer]));
    fireEvent.click(within(turn("a1") as HTMLElement).getByTestId("turn-fold"));
    expect(within(turn("a2") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });
});

describe("a fold never happens under a reader", () => {
  // Criterion 25. The sequence is the one the implementation consult asked for: open a result in the
  // turn a reader is in, then let a newer turn arrive, and the turn they are inside must stay whole.
  it("does not fold a turn a reader has opened a card in", () => {
    const { rerender } = render(thread([older, newest]));
    fireEvent.click(within(turn("a2") as HTMLElement).getByTestId("tool-result-toggle"));
    expect(within(turn("a2") as HTMLElement).getByTestId("tool-result-body")).toBeInTheDocument();

    rerender(thread([older, newest, newer]));

    const t = turn("a2") as HTMLElement;
    expect(within(t).queryByTestId("turn-fold")).toBeNull();
    expect(within(t).getByTestId("tool-result-body")).toBeInTheDocument();
  });

  it("keeps a turn a reader has been inside whole after they close what they opened", () => {
    const { rerender } = render(thread([older, newest]));
    const toggle = within(turn("a2") as HTMLElement).getByTestId("tool-result-toggle");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    rerender(thread([older, newest, newer]));
    expect(within(turn("a2") as HTMLElement).queryByTestId("turn-fold")).toBeNull();
  });

  // Criterion 29, and it is asserted as NODE IDENTITY plus unchanged markup, which is the only form
  // of "did not move" a renderer test can hold: jsdom lays nothing out. What it does prove is the
  // structural reason the criterion holds — folding only ever touches the turn that has just stopped
  // being the newest, which is at the BOTTOM of the thread, so nothing above a reader changes at
  // all. Geometry is what the 360px and 900px walk is for.
  it("changes nothing about the turns above the one that just stopped being newest", () => {
    const { rerender } = render(thread([older, newest]));
    const before = turn("a1") as HTMLElement;
    const markup = before.innerHTML;

    rerender(thread([older, newest, newer]));

    expect(turn("a1")).toBe(before);
    expect((turn("a1") as HTMLElement).innerHTML).toBe(markup);
    // The one turn that DID change is the one that stopped being newest.
    expect(within(turn("a2") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });
});

describe("a disclosure's identity, when the blocks under it move", () => {
  const entry = (extra: CanonicalBlock[] = []): MessageEntry => ({
    id: "m1",
    type: "assistant",
    timestamp: 1,
    content: "",
    blocks: [
      { type: "todos", todos: [{ content: "read the runs", status: "in_progress" }] },
      { type: "tool", toolCall: { id: "tA", name: "Read", output: '{"a":1}' } },
      { type: "tool", toolCall: { id: "tB", name: "Grep", output: '{"b":2}' } },
      ...extra,
    ],
  });

  const render1 = (blocks: CanonicalBlock[] = []) => (
    <DisclosureScope>
      <Conversation items={parseMessages([entry(blocks)])} readOnly />
    </DisclosureScope>
  );

  it("keeps the card the reader opened open when a second task list shifts the indexes", () => {
    const { rerender } = render(render1());
    const toggles = screen.getAllByTestId("tool-result-toggle");
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0] as HTMLElement);
    expect(screen.getByTestId("tool-result-body")).toHaveTextContent('"a": 1');

    // The runner re-emits the whole task list; `dedupeTodos` drops the first, so every block after
    // it moves up one.
    rerender(
      render1([{ type: "todos", todos: [{ content: "read the runs", status: "completed" }] }]),
    );

    const bodies = screen.getAllByTestId("tool-result-body");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveTextContent('"a": 1');
  });

  it("keeps it open when a prepended pause shifts every block", () => {
    const { rerender } = render(render1());
    fireEvent.click(screen.getAllByTestId("tool-result-toggle")[1] as HTMLElement);
    expect(screen.getByTestId("tool-result-body")).toHaveTextContent('"b": 2');

    rerender(
      <DisclosureScope>
        <Conversation
          items={parseMessages([{ ...entry(), thinkingCount: 2 }])}
          readOnly
        />
      </DisclosureScope>,
    );

    expect(screen.getByTestId("thinking-line")).toBeInTheDocument();
    const bodies = screen.getAllByTestId("tool-result-body");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveTextContent('"b": 2');
  });
});

describe("opening the row with a keyboard", () => {
  it("leaves focus on the first thing the row revealed", () => {
    render(thread([older, newest]));
    const t = turn("a1") as HTMLElement;
    const row = within(t).getByTestId("turn-fold");
    row.focus();
    expect(document.activeElement).toBe(row);

    fireEvent.click(row);

    const revealed = within(t).getAllByTestId("tool-result-toggle")[0] as HTMLElement;
    expect(document.activeElement).toBe(revealed);
  });
});

describe("a fold waits for the reader to be at the bottom", () => {
  const scoped = (items: ConversationItem[], atBottom: boolean) => (
    <DisclosureScope atBottom={atBottom}>
      <Conversation items={items} readOnly />
    </DisclosureScope>
  );

  it("does not fold a turn while the reader is somewhere up the thread", () => {
    const { rerender } = render(scoped([older], false));
    rerender(scoped([older, newest], false));
    expect(within(turn("a1") as HTMLElement).queryByTestId("turn-fold")).toBeNull();
    expect(within(turn("a1") as HTMLElement).getAllByTestId("tool-result-summary")).toHaveLength(2);
  });

  it("folds it when a newer turn arrives with the reader back at the bottom", () => {
    const { rerender } = render(scoped([older], false));
    rerender(scoped([older, newest], false));
    expect(within(turn("a1") as HTMLElement).queryByTestId("turn-fold")).toBeNull();

    // They scroll back down, and the next turn lands.
    rerender(scoped([older, newest], true));
    rerender(scoped([older, newest, newer], true));

    expect(within(turn("a1") as HTMLElement).queryByTestId("turn-fold")).toBeNull();
    expect(within(turn("a2") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });

  it("does not unfold what it has folded when the reader scrolls away", () => {
    const { rerender } = render(scoped([older, newest], true));
    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();

    rerender(scoped([older, newest], false));

    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });

  it("opens a reloaded thread with its history already folded", () => {
    render(scoped([older, newest, newer], true));
    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
    expect(within(turn("a2") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });
});

describe("a turn that becomes the newest again", () => {
  const scoped = (items: ConversationItem[], atBottom: boolean) => (
    <DisclosureScope atBottom={atBottom}>
      <Conversation items={items} readOnly />
    </DisclosureScope>
  );

  it("asks again the next time it stops being newest", () => {
    // It folds at the bottom, the turn after it is dropped, and it is newest once more.
    const { rerender } = render(scoped([older, newest], true));
    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();

    rerender(scoped([older], true));
    expect(within(turn("a1") as HTMLElement).queryByTestId("turn-fold")).toBeNull();

    // A replacement lands while the reader is up the thread: its old permission must not apply.
    rerender(scoped([older, newer], false));
    expect(within(turn("a1") as HTMLElement).queryByTestId("turn-fold")).toBeNull();
    expect(within(turn("a1") as HTMLElement).getAllByTestId("tool-result-summary")).toHaveLength(2);
  });
});
