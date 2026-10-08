// @vitest-environment jsdom
//
// ISS-1156 — the board draws work in motion and says by name what it leaves out, so a count here
// never disagrees with the Issues strip in silence.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { boardLeftOut } from "../derive";
import { BoardLeftOut } from "./board-left-out";

expect.extend(matchers);
afterEach(cleanup);

const WORK = { open: 2, in_flight: 9, awaiting_release: 5, blocked_on_person: 9, draft: 4, finished: 8 };

describe("what the board leaves out", () => {
  it("names Draft and Finished with the strip's counts, each a link to the list that holds them", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK)} slug="alpha" drawn={25} matching={25} />);
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

  it("names the states without a figure while the project's counts have not arrived", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(undefined)} slug="alpha" drawn={3} matching={3} />);
    expect(screen.getByRole("link", { name: "Draft" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Finished" })).toBeInTheDocument();
  });

  it("says nothing about a cut page when the columns hold every issue the query matched", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK)} slug="alpha" drawn={25} matching={25} />);
    expect(screen.queryByTestId("board-page-cut")).toBeNull();
  });

  it("says how many a cut page left off, so columns shorter than their state's count are explained", () => {
    render(<BoardLeftOut leftOut={boardLeftOut(WORK)} slug="alpha" drawn={200} matching={231} />);
    expect(screen.getByTestId("board-page-cut")).toHaveTextContent(
      "The columns hold the 200 most recently updated of 231 issues",
    );
  });
});
