// @vitest-environment jsdom
//
// ISS-1083 — the assistant column's width has ONE owner, and it is a measure rather than a
// percentage. jsdom does no layout, so none of this measures pixels: what it measures is the only
// thing that produced the defect, which is which elements carry a cap at all. Two nested caps
// multiply whatever the viewport is, so counting them IS the assertion.
//
// Matchers are extended on vitest's OWN `expect` for the reason `thinking-line.test.tsx` gives.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationItem } from "../types";
import { Conversation } from "./conversation";

expect.extend(matchers);

afterEach(cleanup);

const agentTurn: ConversationItem = {
  kind: "agent",
  id: "a1",
  turnId: "a1",
  text: "Two issues are left.",
  blocks: [{ type: "text", text: "Two issues are left." }],
  attachments: [],
  editedAt: null,
};

const promptTurn: ConversationItem = {
  kind: "prompt",
  id: "p1",
  turnId: "p1",
  text: "what is left?",
  blocks: [],
  attachments: [],
  editedAt: null,
};

/**
 * Every element under `root` carrying a max-width that RESTRICTS the column.
 */
// cm:guard `max-w-full` is deliberately not counted, and the distinction is the whole point: a
// 100% cap cannot compound with anything, and `StreamingText` carries one as a wrapping guard
// beside `break-words`. Counting it would make this test refuse a line that protects long tokens,
// which is a different rule going the other way.
function cappedElements(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>("*"))
    .map((el) => el.getAttribute("class") ?? "")
    .filter((cls) => /(?:^|\s)(?:sm:)?max-w-\[/.test(cls));
}

describe("the assistant column", () => {
  it("carries exactly one max-width, so no two caps can multiply", () => {
    const { container } = render(<Conversation items={[agentTurn]} readOnly />);
    expect(cappedElements(container)).toHaveLength(1);
  });

  it("caps on a readable measure and not on a fraction of the column", () => {
    const { container } = render(<Conversation items={[agentTurn]} readOnly />);
    const [cls] = cappedElements(container);
    expect(cls).toContain("max-w-[72ch]");
    expect(cls).not.toMatch(/max-w-\[\d+%\]/);
  });

  // cm:guard `sm:` asks the VIEWPORT, and this renderer draws a 360-900px resizable dock as well as
  // a full page. A breakpoint here is a rule about the screen applied to a column the screen knows
  // nothing about.
  it("asks no viewport breakpoint what width to be", () => {
    const { container } = render(<Conversation items={[agentTurn]} readOnly />);
    for (const cls of cappedElements(container)) expect(cls).not.toContain("sm:max-w-");
  });

  it("does not shrink-wrap its blocks, so a tool card can fill it", () => {
    const { container } = render(<Conversation items={[agentTurn]} readOnly />);
    const [cls] = cappedElements(container);
    expect(cls).toContain("w-full");
    // cm:why `min-w-0` is asserted: a flex child defaults to `min-width: auto`, so one long
    // unbreakable token inside a tool card would push the column past its own cap.
    expect(cls).toContain("min-w-0");
  });
});

describe("a person's bubble", () => {
  it("keeps a fraction of the column, because not spanning it is what says who spoke", () => {
    const { container } = render(<Conversation items={[promptTurn]} readOnly />);
    const [cls] = cappedElements(container);
    expect(cls).toContain("max-w-[88%]");
  });

  it("asks no viewport breakpoint either", () => {
    const { container } = render(<Conversation items={[promptTurn]} readOnly />);
    for (const cls of cappedElements(container)) expect(cls).not.toContain("sm:max-w-");
  });
});

// cm:guard the tree scan is the only assertion that can see a second literal appearing in a file
// this test never renders — which is exactly how the compounding pair got there: two files, each
// correct on its own. What it proves is bounded and the bound is worth stating: it catches these
// five values in non-test sources under these two features, and it would NOT catch a sixth value, a
// named Tailwind maximum, an inline style, or a cap written in a third feature. A mounted render
// proves one turn; this proves the duplication that actually happened cannot come back the same way.
describe("no second copy of either policy", () => {
  const ROOTS = [
    join(import.meta.dirname, ".."),
    join(import.meta.dirname, "..", "..", "conversations"),
  ];

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(p));
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
    }
    return out;
  }

  it("writes each cap in exactly one file, and that file is layout.ts", () => {
    const holders = ROOTS.flatMap(sources).filter((f) =>
      /max-w-\[(?:72ch|88%|92%|80%|85%)\]/.test(readFileSync(f, "utf8")),
    );
    expect(holders.map((f) => f.split("/").pop())).toEqual(["layout.ts"]);
  });
});
