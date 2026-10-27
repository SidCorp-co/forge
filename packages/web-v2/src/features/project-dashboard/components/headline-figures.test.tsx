// The Dashboard's first row: one number per thing a BA or PM checks first, each a link to where it
// is listed, a dash where there is nothing to count and never an invented figure.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeadlineFigures, type HeadlineFiguresProps } from "./headline-figures";

const HOP: HeadlineFiguresProps = {
  needsYou: 11,
  running: 2,
  atRisk: 0,
  feedback: { open: 13, untriaged: 4, href: "/projects/hop/feedback" },
  next: { version: "0.4.0", eta: "around 24 Oct", href: "/projects/hop/releases/0.4.0" },
  live: { version: "0.3.2", at: "20/10/2026", href: "/projects/hop/status" },
};

const cell = (id: string) => screen.getByTestId(id);

describe("the Dashboard's headline figures", () => {
  it("draws each figure under its label, and links it to where it is listed", () => {
    render(<HeadlineFigures {...HOP} />);
    expect(cell("fig-needs-you")).toHaveTextContent("Needs you11");
    expect(cell("fig-needs-you")).toHaveAttribute("href", "#needs-you");
    expect(cell("fig-feedback")).toHaveTextContent("Open feedback134 untriaged");
    expect(cell("fig-next-release")).toHaveTextContent("Next release0.4.0around 24 Oct");
    expect(cell("fig-next-release")).toHaveAttribute("href", "/projects/hop/releases/0.4.0");
    expect(cell("fig-live")).toHaveTextContent("Last shipped0.3.220/10/2026");
  });

  it("colours a figure only where it asks for the eye: a zero stays plain", () => {
    render(<HeadlineFigures {...HOP} />);
    expect(within(cell("fig-needs-you")).getByText("11").getAttribute("style")).toContain("color");
    expect(within(cell("fig-at-risk")).getByText("0").getAttribute("style")).toBeNull();
  });

  it("draws a dash, never a zero, for a figure still being read or a release that is not there", () => {
    render(<HeadlineFigures {...HOP} needsYou={null} running={null} atRisk={null} next={null} live={null} feedback={{ ...HOP.feedback, untriaged: 0 }} />);
    for (const id of ["fig-needs-you", "fig-running", "fig-at-risk", "fig-next-release", "fig-live"]) expect(within(cell(id)).getByText("—")).toBeInTheDocument();
    expect(cell("fig-feedback")).not.toHaveTextContent("untriaged");
    expect(cell("fig-next-release").tagName).toBe("DIV");
  });
});
