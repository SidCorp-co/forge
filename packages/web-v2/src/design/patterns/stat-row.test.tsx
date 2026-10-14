// A report's numbers in one flush row: a cell is a link to what it counts where it is given one, and
// the row's narrowest cell is the page's choice, so a row of short counts stays on one line.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatCell, StatRow } from "./stat-row";

describe("StatRow and StatCell", () => {
  it("draws a cell with an href as a link to what it counts, and one without as plain text", () => {
    render(
      <StatRow>
        <StatCell label="Fixes" value={2} href="#release-fixed" testId="fixes" />
        <StatCell label="Security" value={0} testId="security" />
      </StatRow>,
    );
    expect(screen.getByRole("link", { name: /Fixes\s*2/ })).toHaveAttribute("href", "#release-fixed");
    expect(screen.getByTestId("security").tagName).toBe("DIV");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("wraps at the narrowest cell the page asks for, 140px where it asks nothing", () => {
    const { rerender } = render(<StatRow testId="row">{null}</StatRow>);
    expect(screen.getByTestId("row").style.gridTemplateColumns).toBe("repeat(auto-fit,minmax(140px,1fr))");
    rerender(
      <StatRow testId="row" cellMin={110}>
        {null}
      </StatRow>,
    );
    expect(screen.getByTestId("row").style.gridTemplateColumns).toBe("repeat(auto-fit,minmax(110px,1fr))");
  });
});
