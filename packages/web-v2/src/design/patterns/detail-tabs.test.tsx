// A detail page's grid: the main column and the facts rail beside it. The main column's pane fills the
// column up to the rail; a cap of its own left a blank band between the content and the rail on a wide
// screen, the gap the release page shipped with.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailLayout, DetailPane } from "./detail-tabs";

describe("DetailLayout and DetailPane", () => {
  it("sets the main column beside a 320px rail and caps neither the column nor its pane", () => {
    render(
      <DetailLayout testId="layout" rail={<aside data-testid="rail" />}>
        <DetailPane label="Overview" testId="pane">
          <p>body</p>
        </DetailPane>
      </DetailLayout>,
    );
    expect(screen.getByTestId("layout").className).toContain("lg:grid-cols-[minmax(0,1fr)_320px]");
    for (let el: HTMLElement | null = screen.getByTestId("pane"); el && el !== screen.getByTestId("layout"); el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)max-w-/);
    }
  });
});
