// @vitest-environment jsdom
//
// ISS-1083 — the caret trails the last WORD, not the last block.
//
// Measured in Chrome at 1200px on 2026-09-17, before the change: a streaming block whose prose is
// one 20px line rendered 44px tall, and the caret element's top sat at 50 while the paragraph's
// bottom was at 44. The same text settled rendered 20px. So the caret was a whole line below the
// words it belonged to, and every streaming block was one line taller than the block it became.
// `Markdown` renders a `<p>` — a block — and an inline span after a block starts a new line box.
//
// The fix has no element after the block: the caret is drawn as an `::after` on the last child
// INSIDE the markdown wrapper, so it sits after the final word and wraps with it. jsdom applies no
// stylesheet and lays nothing out, so what these cases hold is the two halves the browser needs —
// the block says it is streaming, and `globals.css` draws the caret off that. The geometry is the
// walk's: streaming height must equal settled height.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StreamingText } from "./streaming-text";

expect.extend(matchers);

afterEach(cleanup);

const GLOBALS_CSS = join(process.cwd(), "src/app/globals.css");

describe("the block being written", () => {
  it("says so, and carries the class the caret is drawn from", () => {
    const { container } = render(<StreamingText text="Two issues are" streaming />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).toHaveAttribute("data-streaming", "true");
    expect(block.classList.contains("forge-caret")).toBe(true);
  });

  it("says nothing of the kind once it has settled", () => {
    const { container } = render(<StreamingText text="Two issues are left." />);
    const block = container.firstElementChild as HTMLElement;
    expect(block).not.toHaveAttribute("data-streaming");
    expect(block.classList.contains("forge-caret")).toBe(false);
    expect(container.querySelector(".forge-caret")).toBeNull();
  });

  // cm:guard THE defect, as a shape assertion: there is no element after the prose. An inline span
  // following a block `<p>` is a new line box, which is what put the caret a line below the words
  // and made every streaming block one line taller than the same block settled.
  it("draws no element after the prose", () => {
    const { container } = render(<StreamingText text="Two issues are" streaming />);
    const block = container.firstElementChild as HTMLElement;
    expect(block.querySelector("span.forge-caret")).toBeNull();
    expect(block.children).toHaveLength(1);
    expect((block.firstElementChild as HTMLElement).tagName).toBe("DIV");
  });

  it("keeps the prose itself, markdown and all", () => {
    const { container } = render(<StreamingText text="**two** issues are left" streaming />);
    expect(container.querySelector("strong")?.textContent).toBe("two");
  });
});

// cm:guard the same trick `design/focus-ring.test.ts` uses, and for the same reason: the behaviour
// lives in `globals.css`, jsdom applies no stylesheet, and the rule is read as text. What this can
// and cannot hold is stated rather than assumed — it holds the WIRING, that a rule exists which
// generates a visible bar off the class the component sets, and it holds nothing about geometry.
// The geometry is the walk's: measured in Chrome, a streaming block must be exactly as tall as the
// same block settled.
describe("what globals.css draws the caret as", () => {
  const css = readFileSync(GLOBALS_CSS, "utf8");

  /**
   * The caret's own rule, with the reduced-motion block cut away first.
   */
  // cm:guard the two are SPLIT before anything is asserted, and that split is the whole of the
  // implementation consult's F1: every selector this file looks for also appears inside
  // `@media (prefers-reduced-motion)`, so searching the file as one string passed while the rule
  // that actually draws the bar was deleted — the assertions were green over streaming text with no
  // caret at all. Proven by deleting the declaration block below: these go red, the file-wide
  // searches did not.
  // cm:why the comments come out first: this file's own prose names the selectors it is explaining,
  // and a search over the raw text walked out of a comment and into the rule after it — which found
  // the right answer for the wrong reason and would have found one with the rule gone.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const media = code.indexOf("@media (prefers-reduced-motion");
  const normal = code.slice(0, media);
  const reduced = code.slice(media);
  const rule = (normal.match(/\.forge-caret[^{}]*::after[^{}]*\{[^}]*\}/) ?? [""])[0];

  it("draws it as an ::after inside the block, on the last thing in it", () => {
    expect(rule).toMatch(/\.forge-caret\s*>\s*\.forge-caret-anchor\s*>\s*:last-child:not\(ul, ol\)::after/);
  });

  // cm:guard a turn ending in a bullet list is the shape the general rule gets wrong: `::after` on a
  // `<ul>` renders after the list's CONTENT BOX, so the bar floats under the bullets instead of
  // following the words — the same defect one shape along. Watched in Chrome before this selector,
  // where the block measured 96px, and after it, where it measured 76px.
  it("puts it after the last bullet where the block ends in a list", () => {
    expect(rule).toMatch(/:is\(ul, ol\):last-child\s*>\s*li:last-child::after/);
  });

  // cm:guard the DECLARATIONS and not only the selectors, because a selector list with nothing
  // behind it draws nothing: a pseudo-element with no `content` does not exist, and one with no
  // width or no background is invisible. This is what stays true when somebody edits the rule
  // rather than deleting it.
  it("generates something a reader can see", () => {
    expect(rule).toMatch(/content:\s*""/);
    expect(rule).toMatch(/width:\s*[1-9]/);
    expect(rule).toMatch(/background:\s*var\(--/);
    expect(rule).toMatch(/animation:\s*forge-caret/);
  });

  it("hangs off the wrapper NAME rather than off Markdown's shape", () => {
    // `> div >` worked and would have failed in silence the day that component wrapped its output
    // differently — nothing here could have seen it (implementation consult F2).
    expect(rule).not.toMatch(/\.forge-caret\s*>\s*div/);
    expect(code).toMatch(/\.forge-caret-anchor/);
  });

  it("does not draw the block itself as a bar", () => {
    // The old rule was `.forge-caret { display: inline-block; width: 2px; … }`. On the wrapper that
    // now carries the class, a 2px width would collapse the whole answer to a sliver.
    const own = code.match(/(?<![\w-.])\.forge-caret\s*\{[^}]*\}/g) ?? [];
    expect(own).toEqual([]);
  });

  it("still stops moving where a reader has asked for no motion", () => {
    expect(reduced).toMatch(/\.forge-caret\s*>\s*\.forge-caret-anchor/);
    expect(reduced).toMatch(/animation:\s*none\s*!important/);
  });
});
