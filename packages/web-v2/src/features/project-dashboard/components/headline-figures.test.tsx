// The Dashboard's first line: the figures no section below already counts, label first, each a link to
// where it is listed, a dash where there is nothing to count and never an invented figure. Needs you,
// Running and At risk are not figures here: their sections count them (ISS-903).

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeadlineFigures, type HeadlineFiguresProps } from "./headline-figures";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const HOP: HeadlineFiguresProps = {
  feedback: { open: 13, untriaged: 4, href: "/projects/hop/feedback" },
  next: { version: "0.4.0", eta: "around 24 Oct", href: "/projects/hop/releases/0.4.0" },
  live: { version: "0.3.2", at: "20/10/2026", href: "/projects/hop/status" },
};

const cell = (id: string) => screen.getByTestId(id);

describe("the Dashboard's headline figures", () => {
  it("draws each figure after its label, and links it to where it is listed", () => {
    render(<HeadlineFigures {...HOP} />);
    expect(cell("fig-feedback")).toHaveTextContent("Open feedback134 untriaged");
    expect(cell("fig-next-release")).toHaveTextContent("Next release0.4.0around 24 Oct");
    expect(within(cell("fig-next-release")).getByRole("link", { name: "0.4.0" })).toHaveAttribute("href", "/projects/hop/releases/0.4.0");
    expect(cell("fig-live")).toHaveTextContent("Last shipped0.3.220/10/2026");
  });

  it("is one line of three figures, and counts nothing a section below counts", () => {
    render(<HeadlineFigures {...HOP} />);
    expect(within(cell("headline-figures")).getAllByRole("term").map((t) => t.textContent)).toEqual(["Open feedback", "Next release", "Last shipped"]);
    expect(screen.queryByText(/Needs you|Running|At risk/)).toBeNull();
  });

  it("draws a dash, never a zero, for a release that is not there, and links nothing", () => {
    render(<HeadlineFigures {...HOP} next={null} live={null} feedback={{ ...HOP.feedback, untriaged: 0 }} />);
    for (const id of ["fig-next-release", "fig-live"]) {
      expect(within(cell(id)).getByText("—")).toBeInTheDocument();
      expect(within(cell(id)).queryByRole("link")).toBeNull();
    }
    expect(cell("fig-feedback")).not.toHaveTextContent("untriaged");
  });
});
