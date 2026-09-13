// The toolbar's behaviour, asserted where it lives. The editor component can
// only be checked for the buttons' presence — a CodeMirror view in jsdom has no
// layout — so every claim about what a press WRITES is made here.

import { describe, expect, it } from "vitest";
import {
  cycleHeading,
  type Edit,
  makeFence,
  makeLink,
  toggleOrderedList,
  togglePrefix,
  toggleWrap,
} from "./markdown-actions";

/** Apply an edit the way CodeMirror would, so the assertions read as documents. */
function apply(doc: string, e: Edit): string {
  return doc.slice(0, e.from) + e.insert + doc.slice(e.to);
}

describe("toggleWrap", () => {
  it("wraps the selection", () => {
    const e = toggleWrap({ doc: "make it loud", from: 8, to: 12 }, "**");
    expect(apply("make it loud", e)).toBe("make it **loud**");
  });

  it("puts the caret inside an empty pair, so typing lands between the markers", () => {
    const e = toggleWrap({ doc: "", from: 0, to: 0 }, "**");
    expect(apply("", e)).toBe("****");
    expect(e.selectFrom).toBe(2);
    expect(e.selectTo).toBe(2);
  });

  // cm:guard pressing bold twice must return the text to what it was: a second pair makes `****x****`, which renders as literal asterisks rather than as bold.
  it("unwraps when the markers are inside the selection", () => {
    const e = toggleWrap({ doc: "make it **loud**", from: 8, to: 16 }, "**");
    expect(apply("make it **loud**", e)).toBe("make it loud");
  });

  it("unwraps when the markers sit just outside the selection", () => {
    const e = toggleWrap({ doc: "make it **loud**", from: 10, to: 14 }, "**");
    expect(apply("make it **loud**", e)).toBe("make it loud");
  });

  it("keeps the selection on the text, never on the markers", () => {
    const doc = "make it loud";
    const e = toggleWrap({ doc, from: 8, to: 12 }, "**");
    expect(apply(doc, e).slice(e.selectFrom, e.selectTo)).toBe("loud");
  });

  it("works for a one-character marker too", () => {
    const e = toggleWrap({ doc: "call foo now", from: 5, to: 8 }, "`");
    expect(apply("call foo now", e)).toBe("call `foo` now");
  });
});

describe("togglePrefix", () => {
  it("prefixes every line the selection touches", () => {
    const doc = "one\ntwo\nthree";
    const e = togglePrefix({ doc, from: 0, to: 7 }, "> ");
    expect(apply(doc, e)).toBe("> one\n> two\nthree");
  });

  it("removes the prefix when every line already carries it", () => {
    const doc = "> one\n> two";
    const e = togglePrefix({ doc, from: 0, to: 11 }, "> ");
    expect(apply(doc, e)).toBe("one\ntwo");
  });

  // cm:guard a mixed selection is prefixed THROUGHOUT rather than toggled line by line, which would leave a half-quoted block that renders as two blocks.
  it("prefixes throughout when only some lines carry it", () => {
    const doc = "> one\ntwo";
    const e = togglePrefix({ doc, from: 0, to: 9 }, "> ");
    expect(apply(doc, e)).toBe("> one\n> two");
  });

  it("takes the whole line even when the caret sits mid-word", () => {
    const doc = "hello world";
    const e = togglePrefix({ doc, from: 7, to: 7 }, "- ");
    expect(apply(doc, e)).toBe("- hello world");
  });
});

describe("toggleOrderedList", () => {
  it("numbers the selected lines from one", () => {
    const doc = "a\nb\nc";
    const e = toggleOrderedList({ doc, from: 0, to: 5 });
    expect(apply(doc, e)).toBe("1. a\n2. b\n3. c");
  });

  it("unnumbers when every line is already numbered", () => {
    const doc = "1. a\n2. b";
    const e = toggleOrderedList({ doc, from: 0, to: 9 });
    expect(apply(doc, e)).toBe("a\nb");
  });

  // cm:guard stale numbers are REWRITTEN, not kept: markdown renumbers by the first item anyway, so preserving `4.` makes the source disagree with what renders.
  it("renumbers from one rather than keeping what was typed", () => {
    const doc = "4. a\nb";
    const e = toggleOrderedList({ doc, from: 0, to: 6 });
    expect(apply(doc, e)).toBe("1. a\n2. b");
  });
});

describe("makeLink", () => {
  it("wraps the selection and leaves the caret where the url goes", () => {
    const doc = "see the docs";
    const e = makeLink({ doc, from: 8, to: 12 });
    const out = apply(doc, e);
    expect(out).toBe("see the [docs]()");
    expect(out.slice(0, e.selectFrom)).toBe("see the [docs](");
  });

  it("writes a placeholder when nothing is selected", () => {
    const e = makeLink({ doc: "", from: 0, to: 0 });
    expect(apply("", e)).toBe("[text]()");
  });
});

describe("makeFence", () => {
  it("fences the selection with the info string it was given", () => {
    const doc = "graph TD";
    const e = makeFence({ doc, from: 0, to: 8 }, "mermaid");
    expect(apply(doc, e)).toBe("```mermaid\ngraph TD\n```\n");
  });

  // cm:guard a fence opening on the same line as prose is not a fence to any parser — it is three backticks in a paragraph.
  it("breaks the line first when the caret is mid-prose", () => {
    const doc = "here:";
    const e = makeFence({ doc, from: 5, to: 5 }, "");
    expect(apply(doc, e)).toBe("here:\n```\n\n```\n");
  });

  it("leaves the caret inside the fence", () => {
    const doc = "";
    const e = makeFence({ doc, from: 0, to: 0 }, "ts");
    expect(apply(doc, e).slice(0, e.selectFrom)).toBe("```ts\n");
  });
});

describe("cycleHeading", () => {
  // cm:guard `#` is CYCLED and never appended: concatenating on a line that already has one silently demotes, so a reader pressing twice gets `##` instead of a toggle.
  it("goes none → 1 → 2 → 3 → none", () => {
    let doc = "Title";
    for (const want of ["# Title", "## Title", "### Title", "Title"]) {
      const e = cycleHeading({ doc, from: 0, to: 0 });
      doc = apply(doc, e);
      expect(doc).toBe(want);
    }
  });

  it("only touches the line the caret is on", () => {
    const doc = "one\ntwo";
    const e = cycleHeading({ doc, from: 5, to: 5 });
    expect(apply(doc, e)).toBe("one\n# two");
  });
});
