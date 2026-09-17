// @vitest-environment jsdom
//
// ISS-1083 criterion 18 — the caret trails only the text block that is still GROWING.
//
// What it did before: the caret went to the last text block of the live turn by index, whether or
// not anything came after it. So a turn that wrote a sentence and then called a tool left the caret
// blinking at the end of that sentence for the whole of the call — on a `forge_issues` sweep, a
// minute of a cursor saying prose was being typed above a card that said the tool was still out.
//
// A block only grows at the END of a turn, because a turn is append-only. So "still growing" and
// "is the last block" are the same statement, and that is the whole of the rule.
//
// Matchers are extended on vitest's OWN `expect` for the reason `thinking-line.test.tsx` gives.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationItem, RenderBlock } from "../types";
import { Conversation } from "./conversation";

expect.extend(matchers);

afterEach(cleanup);

const text = (t: string): RenderBlock => ({ type: "text", text: t });
const tool = (id: string, over: Partial<RenderBlock & { result: unknown }> = {}): RenderBlock => ({
  type: "tool",
  tool: { id, name: "forge_issues", ...(over as object) },
});

const agent = (blocks: RenderBlock[], id = "a1"): ConversationItem => ({
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

/** Every caret in the tree, and the text of the block carrying it. */
// cm:guard `.forge-caret` is the STREAMING BLOCK itself since the caret became an `::after` on its
// last line rather than an element after it (ISS-1083, `streaming-text.tsx`), so this reads the
// element's own text. It used to read `parentElement`, which was the same string while a turn held
// one block and the whole turn's text once it held several — the two cases below are why that
// mattered.
const carets = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll(".forge-caret")).map((c) => c.textContent ?? "");

describe("where the caret goes while a turn streams", () => {
  it("trails the prose a turn is writing", () => {
    const { container } = render(
      <Conversation items={[agent([text("Two issues are")])]} readOnly streaming />,
    );
    expect(carets(container)).toEqual(["Two issues are"]);
  });

  // THE defect. The tool card says `Running…` and the caret must not simultaneously claim the
  // prose above it is still being typed.
  it("leaves none on a turn whose tail is a tool call", () => {
    const { container } = render(
      <Conversation
        items={[agent([text("Let me look."), tool("t1")])]}
        readOnly
        streaming
      />,
    );
    expect(carets(container)).toEqual([]);
  });

  it("moves to the prose after the call once that prose starts", () => {
    const { container } = render(
      <Conversation
        items={[agent([text("Let me look."), tool("t1"), text("Two are left.")])]}
        readOnly
        streaming
      />,
    );
    expect(carets(container)).toEqual(["Two are left."]);
  });

  // cm:guard EXACTLY ONE, which the earlier rule could not promise: it planted the caret on the
  // last text block by index, so a turn holding two text blocks and nothing after them was fine —
  // and a turn holding text, a call, and more text was fine too — but neither was the same rule.
  it("never draws two at once, however many text blocks the turn holds", () => {
    const { container } = render(
      <Conversation
        items={[agent([text("One."), text("Two."), tool("t1"), text("Three.")])]}
        readOnly
        streaming
      />,
    );
    expect(carets(container)).toHaveLength(1);
    expect(carets(container)).toEqual(["Three."]);
  });

  it("leaves none on a turn that has settled", () => {
    const { container } = render(
      <Conversation items={[agent([text("Two are left.")])]} readOnly />,
    );
    expect(carets(container)).toEqual([]);
  });

  // cm:guard the caret is the LIVE TAIL turn's alone. A thread's earlier turns are all settled, and
  // a caret on one of them would say a finished turn was still being written.
  it("leaves none on the turns above the one being written", () => {
    const { container } = render(
      <Conversation
        items={[agent([text("First answer.")], "a1"), agent([text("Second answ")], "a2")]}
        readOnly
        streaming
      />,
    );
    expect(carets(container)).toEqual(["Second answ"]);
  });

  // cm:guard a thinking pause at the tail carries no caret either, and it is a separate outcome
  // from the tool case: `ThinkingLine` takes a `streaming` prop of its own, read off
  // `i === item.blocks.length - 1`, so the pause itself says it is still going. The prose above it
  // must not also claim to be.
  it("leaves the prose alone while the turn is paused to think", () => {
    const { container } = render(
      <Conversation
        items={[agent([text("Let me think."), { type: "thinking", count: 1 }])]}
        readOnly
        streaming
      />,
    );
    expect(carets(container)).toEqual([]);
  });
});

// cm:guard the resident master's finding on ISS-1083, 2026-09-17: before this change a live turn
// whose blocks were `[text, thinking]` satisfied BOTH live conditions at once — the caret went to
// the last TEXT block, and `ThinkingLine` reads "Thinking…" on `i === blocks.length - 1` — so two
// things on screen claimed the turn was live and one of them pointed at a block that had stopped
// growing. The comment's own note is why this case is not a caret query: the second indicator is a
// different element with different markup, and counting `.forge-caret` alone would have missed it.
//
// cm:guard what these cases hold is the exclusivity of the two BLOCK-LEVEL indicators, and nothing
// wider: `Conversation` draws no stage line and no outbox row, so neither is mountable here and a
// total of one is not what is being asserted (final consult F1). The stage line is a fact about the
// TURN and the two below are facts about blocks — a turn reading `Working…` while its pause reads
// `Thinking…` is two scales agreeing, and the stage line's own position is criterion 17's, held in
// `turn-stage.test.tsx` as node identity.
describe("which block-level indicator speaks", () => {
  // cm:guard the LABEL is read and never the line's whole text: a settled pause a reader has opened
  // puts its reasoning inside the same wrapper, and reasoning that happens to contain the word would
  // count a finished block as live (final consult F2). The toggle holds the label alone where there
  // is one; a pause with nothing to open onto has no children but its label.
  const spokenLabel = (el: Element) =>
    el.querySelector('[data-testid="thinking-line-toggle"]')?.textContent ?? el.textContent ?? "";
  const claims = (root: HTMLElement) => [
    ...Array.from(root.querySelectorAll(".forge-caret")).map(() => "caret"),
    ...Array.from(root.querySelectorAll('[data-testid="thinking-line"]'))
      .filter((el) => spokenLabel(el).includes("Thinking…"))
      .map(() => "thinking"),
  ];

  it("lets the pause speak alone while the turn is thinking after having written", () => {
    const { container } = render(
      <Conversation
        items={[agent([text("Let me think about that."), { type: "thinking" }])]}
        readOnly
        streaming
      />,
    );
    expect(claims(container)).toEqual(["thinking"]);
  });

  it("lets the caret speak alone while the turn is writing after having thought", () => {
    const { container } = render(
      <Conversation
        items={[agent([{ type: "thinking", durationMs: 400 }, text("Here is what I found")])]}
        readOnly
        streaming
      />,
    );
    expect(claims(container)).toEqual(["caret"]);
  });

  // cm:guard and neither speaks while a tool is out, because the CARD says `Running…` and the turn's
  // own stage line says `Working…`. Three claims about one turn is the noise this rule ends.
  it("leaves both silent while a tool call is out", () => {
    const { container } = render(
      <Conversation items={[agent([text("Let me look."), tool("t1")])]} readOnly streaming />,
    );
    expect(claims(container)).toEqual([]);
  });

  // cm:guard F2's own sequence: a settled pause whose reasoning holds the word, OPENED, beside prose
  // that is still growing. Read off the wrapper's text this reported two claims and named the
  // finished block as one of them.
  it("does not hear a settled pause whose reasoning quotes the word", () => {
    const { container } = render(
      <Conversation
        items={[
          agent([
            { type: "thinking", text: "Thinking… about which run to read first", durationMs: 900 },
            text("Here is what I found"),
          ]),
        ]}
        readOnly
        streaming
      />,
    );
    fireEvent.click(screen.getByTestId("thinking-line-toggle"));
    expect(screen.getByTestId("thinking-line-text")).toHaveTextContent("Thinking…");
    expect(claims(container)).toEqual(["caret"]);
  });
});
