// @vitest-environment jsdom
//
// ISS-1159 — each figure on the strip carries what it is measured against, and the Needs you figure
// states nothing it has not read (ISS-1156).

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatStrip, type StatStripProps } from "./stat-strip";

expect.extend(matchers);
afterEach(cleanup);

const base: StatStripProps = {
  liveRuns: 3,
  busyRunners: 2,
  onlineRunners: 4,
  needsYou: 2,
  needsYouCaption: "to act on: 1 failed job · 1 to review",
  oldestWait: "112d",
  openWork: 72,
  openWorkMadeOf: "56 open, not picked up · 11 in flight",
  spendTodayUsd: 14,
  spendComparison: "2.0× the 7-day daily average of $7.00",
  inFlightUsd: 0,
};

const figure = (label: string) => {
  const dt = screen.getByText(label);
  const group = dt.parentElement;
  if (!group) throw new Error(`no figure ${label}`);
  return within(group);
};

describe("the figures strip", () => {
  it("measures each figure against something the data holds", () => {
    render(<StatStrip {...base} />);
    expect(figure("Runs live").getByText("2 of 4 runners busy")).toBeInTheDocument();
    expect(figure("Needs you").getByText("oldest 112d · to act on: 1 failed job · 1 to review")).toBeInTheDocument();
    expect(figure("Open work").getByText("56 open, not picked up · 11 in flight")).toBeInTheDocument();
    expect(figure("Spend, 24h").getByText("2.0× the 7-day daily average of $7.00")).toBeInTheDocument();
  });

  it("says how many runs are open where the figure counts fewer, since the navigation rail counts them all", () => {
    render(<StatStrip {...base} liveRuns={0} openRuns={6} />);
    expect(figure("Runs live").getByText("2 of 4 runners busy · 6 runs open in all")).toBeInTheDocument();
  });

  it("states no runner count while the runners read is out", () => {
    render(<StatStrip {...base} runnersUnread />);
    expect(figure("Runs live").getByText("runners not read")).toBeInTheDocument();
    expect(figure("Runs live").queryByText(/runners busy/)).toBeNull();
  });

  it("shows no comparison for spend where the week holds none, and invents none", () => {
    render(<StatStrip {...base} spendComparison={null} />);
    expect(figure("Spend, 24h").queryByText(/average/)).toBeNull();
  });

  it("states no figure for Needs you while the answer is on its way", () => {
    render(<StatStrip {...base} needsYouPending />);
    const n = figure("Needs you");
    expect(n.getByText("…")).toBeInTheDocument();
    expect(n.queryByText("2")).toBeNull();
    expect(n.getByText("reading what needs you…")).toBeInTheDocument();
  });

  it("states no zero and no 'nothing to act on' where the list is empty because a read it stands on is out", () => {
    render(
      <StatStrip
        {...base}
        needsYou={0}
        needsYouCaption="nothing to act on"
        oldestWait={null}
        needsYouUnread={["The project's runs are still being read."]}
      />,
    );
    const n = figure("Needs you");
    expect(n.getByText("—")).toBeInTheDocument();
    expect(n.queryByText("0")).toBeNull();
    expect(n.queryByText(/nothing to act on/)).toBeNull();
    expect(n.getByText(/not an all clear · The project's runs are still being read\./)).toBeInTheDocument();
  });

  it("keeps the count of what is listed even while a read is out, since those items are real", () => {
    render(<StatStrip {...base} needsYouUnread={["The project's runs are still being read."]} />);
    expect(figure("Needs you").getByText("2")).toBeInTheDocument();
  });

  it("still says nothing to act on once every read is in", () => {
    render(<StatStrip {...base} needsYou={0} needsYouCaption="nothing to act on" oldestWait={null} needsYouUnread={[]} />);
    expect(figure("Needs you").getByText("nothing to act on")).toBeInTheDocument();
  });

  it("refuses by name in place of the figure where the response cannot support one", () => {
    render(<StatStrip {...base} needsYouRefusal="Needs you could not be read: offline." />);
    const n = figure("Needs you");
    expect(n.getByText("—")).toBeInTheDocument();
    expect(n.getByText(/could not be read: offline/)).toBeInTheDocument();
  });

  it("states no run count while the runs read has not arrived", () => {
    render(<StatStrip {...base} runsUnread />);
    const n = figure("Runs live");
    expect(n.getByText("…")).toBeInTheDocument();
    expect(n.queryByText("3")).toBeNull();
    expect(n.getByText("runs not read")).toBeInTheDocument();
  });

  it("does not carry the Pass rate placeholder as a figure", () => {
    render(<StatStrip {...base} />);
    expect(screen.queryByText("Pass rate")).toBeNull();
  });
});
