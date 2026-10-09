// @vitest-environment jsdom
//
// ISS-1156 — the board draws work in motion and says by name what it leaves out, so a count here
// never disagrees with the Issues strip in silence.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type StateFigure, boardLeftOut } from "../derive";
import { BoardLeftOut } from "./board-left-out";

expect.extend(matchers);
afterEach(cleanup);

const WORK = { open: 2, in_flight: 9, awaiting_release: 5, blocked_on_person: 9, draft: 4, finished: 8 };

const figure = (state: StateFigure["state"], label: string, total: number, drawn: number): StateFigure => ({
  state,
  label,
  total,
  drawn,
});
/** Every open state drawn in full. */
const WHOLE: StateFigure[] = [
  figure("open", "Open, not picked up", 2, 2),
  figure("in_flight", "In flight", 9, 9),
  figure("awaiting_release", "Awaiting release", 5, 5),
  figure("blocked_on_person", "Blocked on a person", 9, 9),
];
/** The 230-issue project the judge walked: one page of 200, so each state is short of its count. */
const CUT: StateFigure[] = [
  figure("open", "Open, not picked up", 46, 40),
  figure("in_flight", "In flight", 92, 80),
  figure("awaiting_release", "Awaiting release", 46, 40),
  figure("blocked_on_person", "Blocked on a person", 46, 40),
];

describe("what the board leaves out", () => {
  it("names Draft and Finished with the strip's counts, each a link to the list that holds them", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK, "read")} figures={WHOLE} slug="alpha" />);
    expect(screen.getByRole("link", { name: "Draft 4" })).toHaveAttribute(
      "href",
      "/projects/alpha/issues?filter=draft",
    );
    expect(screen.getByRole("link", { name: "Finished 8" })).toHaveAttribute(
      "href",
      "/projects/alpha/issues?filter=finished",
    );
    expect(screen.getByTestId("board-left-out")).toHaveTextContent("Not drawn on this board");
  });

  it("names the states without a figure while the project's counts are on their way", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(undefined, "pending")} figures={WHOLE} slug="alpha" />);
    expect(screen.getByLabelText("reading Draft's count")).toHaveTextContent("…");
    expect(screen.getByLabelText("reading Finished's count")).toHaveTextContent("…");
  });

  it("says by name that the count could not be read, instead of naming the state with none", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK, "failed")} figures={WHOLE} slug="alpha" />);
    expect(screen.getByLabelText("Draft's count could not be read")).toHaveTextContent("!");
    expect(screen.getByLabelText("Finished's count could not be read")).toHaveTextContent("!");
    expect(screen.queryByRole("link", { name: /Draft 4/ })).toBeNull();
  });

  it("says nothing about a cut page when every state's columns hold what the search counts", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK, "read")} figures={WHOLE} slug="alpha" />);
    expect(screen.queryByTestId("board-page-cut")).toBeNull();
  });

  it("names each state its page left short, with how many it drew of how many, and a link to them", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK, "read")} figures={CUT} slug="alpha" />);
    const cut = screen.getByTestId("board-page-cut");
    expect(cut).toHaveTextContent("The columns hold 200 of the 230 open issues");
    expect(screen.getByRole("link", { name: "In flight: 80 of 92 drawn" })).toHaveAttribute(
      "href",
      "/projects/alpha/issues?filter=in_flight",
    );
    expect(screen.getByRole("link", { name: "Open, not picked up: 40 of 46 drawn" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Awaiting release: 40 of 46 drawn" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blocked on a person: 40 of 46 drawn" })).toBeInTheDocument();
  });

  it("names only the state that is short, leaving the whole ones out", () => {
    const figures = WHOLE.map((f) => (f.state === "in_flight" ? { ...f, total: 12 } : f));
    render(<BoardLeftOut leftOut={boardLeftOut(WORK, "read")} figures={figures} slug="alpha" />);
    expect(screen.getByRole("link", { name: "In flight: 9 of 12 drawn" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Open, not picked up:/ })).toBeNull();
  });

  it("says so when the columns hold more than the search counts, rather than reading it as a cut page", () => {
    const figures = WHOLE.map((f) => (f.state === "open" ? { ...f, drawn: 3 } : f));
    render(<BoardLeftOut leftOut={boardLeftOut(WORK, "read")} figures={figures} slug="alpha" />);
    expect(
      screen.getByRole("link", { name: "Open, not picked up: the board draws 3, Issues counts 2" }),
    ).toBeInTheDocument();
  });
});
