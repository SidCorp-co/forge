// @vitest-environment jsdom
//
// ISS-1033 — the stale row has to be told from a fresh one WITHOUT reading the
// number. jsdom loads no stylesheet, so a test that rendered the cell and read
// `getComputedStyle` would report the browser default for every row and pass
// whatever the classes said. The two assertions below are therefore about the
// two facts the rendered colour actually rests on, each of which can go red on
// its own: the span asks for the mark by a class the cascade lets through, and
// that class is declared where it outranks `.fg-caption`.
//
// What shipped and failed: `font-semibold text-[color:var(--amber-600)]`
// spelled on the same span as `fg-caption`. `.fg-caption` is unlayered, every
// Tailwind utility lives in `@layer utilities`, and an unlayered rule beats a
// layered one whatever its specificity — so on beta at d0389485c a row that had
// not moved in 2d computed to rgb(118,125,138) at weight 500, identical to the
// row above it that moved 2h ago.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WaitingCell } from "./issue-table-row";

expect.extend(matchers);

afterEach(cleanup);

const classesOf = (waited: { label: string; stale: boolean } | null) => {
  const { container } = render(<WaitingCell waited={waited} />);
  const span = container.querySelector("span");
  if (!span) throw new Error("WaitingCell rendered no span");
  return span.className.split(/\s+/).filter(Boolean);
};

// A utility that colours or weights text. Any of these on the same span as
// `fg-caption` is a no-op, so a class list carrying one is a mark that is not
// being drawn.
const SWALLOWED =
  /^(font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|text-(?!\[?(xs|sm|base|lg|xl|\d)).*(muted|subtle|default|accent|\[color:))/;

describe("the stale mark reaches the cascade", () => {
  it("asks for the mark by a class that is not swallowed by fg-caption", () => {
    const stale = classesOf({ label: "2d", stale: true });
    expect(stale).toContain("fg-caption-stale");
    expect(stale.filter((c) => SWALLOWED.test(c))).toEqual([]);
  });

  it("leaves a freshly moved row unmarked, and asks it for no dead colour either", () => {
    const fresh = classesOf({ label: "2h", stale: false });
    expect(fresh).not.toContain("fg-caption-stale");
    expect(fresh.filter((c) => SWALLOWED.test(c))).toEqual([]);
  });

  it("renders a dash for a settled row rather than a figure or a zero", () => {
    const { container } = render(<WaitingCell waited={null} />);
    expect(container.textContent).toBe("—");
  });
});

describe("the mark outranks the type style it sits beside", () => {
  const css = readFileSync(
    join(import.meta.dirname, "../../../styles/tokens.css"),
    "utf8",
  );

  it("declares fg-caption-stale AFTER fg-caption, which is what makes it win", () => {
    const caption = css.indexOf(".fg-caption {");
    const stale = css.indexOf(".fg-caption-stale {");
    expect(caption).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(caption);
  });

  it("gives the mark both of the properties fg-caption would otherwise set", () => {
    const rule = css.slice(
      css.indexOf(".fg-caption-stale {"),
      css.indexOf("}", css.indexOf(".fg-caption-stale {")),
    );
    expect(rule).toMatch(/font-weight:\s*[6-9]00/);
    expect(rule).toMatch(/color:\s*var\(--amber-600\)/);
  });

  it("keeps the mark unlayered, as the type style it has to outrank is", () => {
    const before = css.slice(0, css.indexOf(".fg-caption-stale {"));
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closed = (before.match(/\}/g) ?? []).length;
    expect(opened).toBeLessThanOrEqual(closed);
  });
});
