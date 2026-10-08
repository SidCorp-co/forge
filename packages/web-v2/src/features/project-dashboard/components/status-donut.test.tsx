// @vitest-environment jsdom
//
// ISS-1156 — the legend names every state in full. A word cut to "Open, not pick…" with no way to
// read the rest is a figure nobody can interpret.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_WORK_STATES, WORK_STATE_LABELS } from "@forge/contracts/work-state";
import { statusDonut } from "../derive";
import { StatusDonut } from "./status-donut";

expect.extend(matchers);
afterEach(cleanup);

const WORK = { open: 56, in_flight: 11, awaiting_release: 1, blocked_on_person: 4, draft: 24, finished: 1306 };

describe("the Open work donut legend", () => {
  it("prints each open state's full word, and clips none of them", () => {
    render(<StatusDonut data={statusDonut(WORK)} />);
    for (const state of OPEN_WORK_STATES) {
      const row = screen.getByText(WORK_STATE_LABELS[state]);
      expect(row).toBeInTheDocument();
      expect(row.className, `${state} is clipped`).not.toMatch(/truncate|text-ellipsis|line-clamp/);
    }
  });

  it("titles itself with the open work word and prints the figure at the ring's centre", () => {
    render(<StatusDonut data={statusDonut(WORK)} />);
    expect(screen.getByText("Open work by state")).toBeInTheDocument();
    expect(screen.getByText("72")).toBeInTheDocument();
  });
});
