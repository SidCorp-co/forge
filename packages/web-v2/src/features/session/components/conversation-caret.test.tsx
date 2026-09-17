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
import { cleanup, render } from "@testing-library/react";
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

/** Every caret in the tree, and the text its own block holds. */
const carets = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll(".forge-caret")).map(
    (c) => c.parentElement?.textContent?.replace("", "") ?? "",
  );

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
