// A kept report and a share page print as the report alone (REQ-32 B4). The print stylesheet in
// `globals.css` drops what a page marks as chrome and lets the shell's one-screen frame run onto
// as many sheets as it needs; the workspace layout marks its chrome and its frame. The report's own
// actions carry `print:hidden` (asserted where they render, `status-history.test.tsx`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");
const layout = readFileSync(join(__dirname, "(workspace)/layout.tsx"), "utf8");

/** The body of the one `@media print` block, braces balanced. */
function printBlock(): string {
  const start = css.indexOf("@media print {");
  expect(start, "globals.css holds a @media print block").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("the @media print block is not closed");
}

describe("the print stylesheet", () => {
  it("hides what a page marks as chrome, and unclips the shell's frame", () => {
    const print = printBlock();
    expect(print).toMatch(/\[data-print="chrome"\]\s*\{\s*display:\s*none !important;/);
    expect(print).toMatch(/\[data-print="frame"\]\s*\{[^}]*height:\s*auto !important;[^}]*overflow:\s*visible !important;/);
  });

  it("never breaks a table row across a page, and repeats a table's heading", () => {
    const print = printBlock();
    expect(print).toMatch(/tr, li, figcaption\s*\{\s*break-inside:\s*avoid;/);
    expect(print).toMatch(/thead\s*\{\s*display:\s*table-header-group;/);
  });

  it("is applied by the workspace: the sidebar, the top bar, the dock and the bottom bar are chrome", () => {
    expect(layout).toMatch(/data-testid="desktop-sidebar" data-print="chrome"/);
    expect(layout.match(/data-print="chrome"/g)).toHaveLength(3);
    expect(layout.match(/data-print="frame"/g)).toHaveLength(3);
    const top = layout.indexOf('<div className="contents" data-print="chrome">');
    expect(layout.indexOf("<ShellTopBar", top)).toBeGreaterThan(top);
    expect(layout.lastIndexOf('data-print="chrome"', layout.indexOf("<BottomTabBar"))).toBeGreaterThan(layout.indexOf("<main"));
  });
});
