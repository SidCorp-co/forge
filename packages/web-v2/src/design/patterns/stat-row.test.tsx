// A report's numbers in one flush row: a cell is a link to what it counts where it is given one, and
// the row's narrowest cell is the page's choice, so a row of short counts stays on one line, and a
// row that knows its cell count wraps into even lines.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatCell, StatRow, statTrack } from "./stat-row";

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
    const track = () => screen.getByTestId("row").style.getPropertyValue("--stat-track");
    expect(track()).toBe("140px");
    rerender(
      <StatRow testId="row" cellMin={110}>
        {null}
      </StatRow>,
    );
    expect(track()).toBe("110px");
  });

  it("given its cell count, wraps into even lines: all on one line, else half a line each, else two a line", () => {
    render(
      <StatRow testId="row" cellMin={110} cells={6}>
        {null}
      </StatRow>,
    );
    expect(screen.getByTestId("row").style.getPropertyValue("--stat-track")).toBe(statTrack(6, 110));
    // six cells fit one line from 660px, three a line from 330px, two a line below that
    expect(statTrack(6, 110)).toBe("clamp(calc((100% - 1px) / 6), (660px - 100%) * 999, clamp(calc((100% - 1px) / 3), (330px - 100%) * 999, calc((100% - 1px) / 2)))");
    // an odd count takes the larger half a line, never a line of one under a full one
    expect(statTrack(5, 140)).toContain("calc((100% - 1px) / 3), (420px - 100%)");
  });
});
