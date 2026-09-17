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

  // cm:guard the PROSE of a folded turn is untouched, in order: the fold hides the machinery and
  // never the answer, which is the whole reason a reader can still scan history after it folds.
  it("keeps a folded turn's prose, and keeps its order", () => {
    render(thread([older, newest]));
    const t = turn("a1") as HTMLElement;
    expect(t.textContent).toContain("Let me look at the runs.");
    expect(t.textContent).toContain("Two are still running.");
    expect(t.textContent?.indexOf("Let me look")).toBeLessThan(
      t.textContent?.indexOf("Two are still") ?? -1,
    );
  });

  // cm:guard a lone turn never folds, whatever it holds. `Conversation` is mounted once per turn on
  // the chat surface, so this is the case that says an instance seeing one item leaves it alone
  // rather than folding the only thing on screen.
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

  // cm:guard opening one turn's row says nothing about any other turn's: the fold is a per-turn
  // state and a reader who opens one piece of history has not asked for all of it.
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

  // cm:guard and it stays unfolded after they CLOSE it, which is what `touched` is for: a turn that
  // folded the instant a reader closed the one card they had opened would take away what they were
  // reading, and their own click would be what did it.
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

// cm:guard THE sequence the implementation consult named (F1), and it goes through `parseMessages`
// rather than hand-built blocks because the instability is in that function: `dedupeTodos` drops
// every task list but the last, so a second one arriving shifts every block after the first, and
// `withPauseCount` prepends a pause, which shifts all of them. Keyed by index — which is what the
// first cut did — the reader's open result closed itself and the card below it inherited the key,
// on a turn where nothing about either card had changed.
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

  // cm:guard the same for a PREPENDED pause, which moves every block in the turn: `withPauseCount`
  // puts a turn's `thinkingCount` at the front, so this is the shift that lands on a Claude Code
  // turn the moment its count arrives.
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

// cm:guard the row REMOVES itself when it opens, so a keyboard user who activated it would be left
// on `document.body` with no place in the thread. Focus moves into what they asked for
// (implementation consult F3).
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

// cm:guard THE case the implementation consult's F2 named, and the one my own structural claim got
// wrong: I had it at turn granularity — folding only touches the turn that just stopped being
// newest, so the height that vanishes is at the bottom — and a reader can be INSIDE that turn,
// below its cards, reading its closing prose. Then the height that vanishes is above them and what
// they are reading moves. So a turn folds only if the reader was at the bottom at the moment it
// stopped being newest.
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

  // cm:guard LATCHED, and this is the half that made the gate safe rather than the same defect with
  // its sign flipped: read live, `atBottom` going false the moment a reader scrolls up would unfold
  // every folded turn in the thread at once, and all of them would move.
  it("does not unfold what it has folded when the reader scrolls away", () => {
    const { rerender } = render(scoped([older, newest], true));
    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();

    rerender(scoped([older, newest], false));

    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });

  // cm:guard a thread MOUNTING already deep in history folds its old turns with no transition to
  // watch, which is every reload: the scroll hook puts the reader at the bottom, so `atBottom` is
  // true on the first render and there is no expanded frame to see.
  it("opens a reloaded thread with its history already folded", () => {
    render(scoped([older, newest, newer], true));
    expect(within(turn("a1") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
    expect(within(turn("a2") as HTMLElement).getByTestId("turn-fold")).toBeInTheDocument();
  });
});

// cm:guard the latch is RELEASED when a turn becomes the newest again, and the sequence is not
// hypothetical: regenerating or editing a turn drops the ones after it, and on the chat surface an
// optimistic entry can vanish. Without the release the turn folded again on its second transition
// with the permission it had captured on its first (scroll consult F1).
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
