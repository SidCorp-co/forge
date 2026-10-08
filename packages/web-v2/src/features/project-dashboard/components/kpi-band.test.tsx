// @vitest-environment jsdom
//
// ISS-1156 — the Needs you tile sits beside Open work and a donut that reads Blocked on a person.
// It counts items to act on rather than issues in a state, and its caption says which.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KpiBand } from "./kpi-band";

expect.extend(matchers);
afterEach(cleanup);

describe("the KPI band", () => {
  it("captions Needs you with what it counts, by kind", () => {
    render(
      <KpiBand
        liveRuns={0}
        busyRunners={0}
        onlineRunners={0}
        needsYou={14}
        needsYouCaption="to act on: 5 failed jobs · 9 questions"
        openWork={72}
        spendTodayUsd={0}
        inFlightUsd={0}
      />,
    );
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("to act on: 5 failed jobs · 9 questions")).toBeInTheDocument();
  });

  it("names the Open work tile with the word and the four states it sums", () => {
    render(
      <KpiBand
        liveRuns={0}
        busyRunners={0}
        onlineRunners={0}
        needsYou={0}
        needsYouCaption="nothing to act on"
        openWork={72}
        spendTodayUsd={0}
        inFlightUsd={0}
      />,
    );
    expect(screen.getByText("Open work")).toBeInTheDocument();
    expect(
      screen.getByText("Open, not picked up · In flight · Awaiting release · Blocked on a person"),
    ).toBeInTheDocument();
  });
});
