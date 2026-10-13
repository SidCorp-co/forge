// @vitest-environment jsdom
//
// ISS-1166 / ISS-1169, round 3: a name that has less room than it needs is cut on one line, and the
// whole of it stays reachable in the element's title. The layout half (never broken mid-word, at 390px)
// is measured in a real Chrome by `design/patterns/sticky-reach.test.tsx`.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Truncated } from "./truncated";

expect.extend(matchers);
afterEach(cleanup);

describe("Truncated", () => {
  it("draws the whole text and carries the whole of it as its title", () => {
    render(<Truncated text="AdminHub UI" />);
    const el = screen.getByText("AdminHub UI");
    expect(el).toHaveAttribute("title", "AdminHub UI");
  });

  it("is a single line that may shrink inside its cell, and takes the caller's classes", () => {
    render(<Truncated text="SID_GROWTH" className="font-mono" />);
    const el = screen.getByText("SID_GROWTH");
    expect(el).toHaveClass("truncate", "min-w-0", "block", "font-mono");
  });
});
