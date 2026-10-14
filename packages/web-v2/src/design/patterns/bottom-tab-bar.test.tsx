// @vitest-environment jsdom
//
// ISS-1262: the bar is as tall as the strip the shell reserves for it.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BottomTabBar } from "./bottom-tab-bar";

afterEach(cleanup);

function reservedPx(): number {
  const layout = readFileSync(resolve(process.cwd(), "src/app/(workspace)/layout.tsx"), "utf8");
  const found = /pb-\[calc\((\d+)px\+env\(safe-area-inset-bottom\)\)\] md:pb-0/.exec(layout);
  if (!found) throw new Error("the workspace layout no longer reserves a strip for the tab bar under the page");
  return Number(found[1]);
}

describe("the bottom tab bar", () => {
  it("is as tall as the strip the shell reserves for it: a tab, plus the 1px rule above them", () => {
    render(<BottomTabBar items={[{ key: "a", label: "A", icon: "inbox" }]} activeKey="" onSelect={() => {}} />);
    const tab = screen.getByRole("button").className.match(/min-h-\[(\d+)px\]/);
    expect(tab).not.toBeNull();
    const nav = screen.getByRole("navigation");
    expect(nav.className).toContain("border-t");
    expect(Number(tab?.[1]) + 1).toBe(reservedPx());
  });
});
