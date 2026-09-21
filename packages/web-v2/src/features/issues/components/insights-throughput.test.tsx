// @vitest-environment jsdom
//
// The throughput series, pinned across ISS-999.
//
// ISS-999 rebuilt the panel BESIDE this chart — the seven per-stage funnel cards, which counted
// issues through a status→stage map the kernel does not have — and left the throughput derivation
// alone. "Left alone" is a claim about a diff, and a diff is read once. This fixture is the claim
// in a form that fails: the same rows in, the same bars, order, heights, weekday labels and total
// out, whatever happens to the file around it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThroughputRow } from "@/features/pipeline/types";
import { ThroughputChart } from "./issues-insights-view";

expect.extend(matchers);
afterEach(cleanup);

const ROWS: ThroughputRow[] = [
  { projectId: "p1", date: "2026-09-10", count: 1 },
  { projectId: "p1", date: "2026-09-08", count: 4 },
  { projectId: "p1", date: "2026-09-11", count: 0 },
  { projectId: "p1", date: "2026-09-09", count: 2 },
];

function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll("span[title]")) as HTMLElement[];
}

describe("ThroughputChart — characterization fixture (ISS-999)", () => {
  it("orders the bars by date ascending whatever order the rows arrive in", () => {
    render(<ThroughputChart rows={ROWS} />);
    expect(screen.getAllByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/).map((n) => n.textContent)).toEqual(
      ["Tue", "Wed", "Thu", "Fri"],
    );
  });

  it("scales each bar against the busiest day and floors an empty day at 4%", () => {
    render(<ThroughputChart rows={ROWS} />);
    expect(bars().map((b) => b.style.height)).toEqual(["100%", "50%", "25%", "4%"]);
  });

  it("titles every bar with its own count", () => {
    render(<ThroughputChart rows={ROWS} />);
    expect(bars().map((b) => b.getAttribute("title"))).toEqual([
      "4 shipped",
      "2 shipped",
      "1 shipped",
      "0 shipped",
    ]);
  });

  it("sums the window into the caption", () => {
    render(<ThroughputChart rows={ROWS} />);
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText(/shipped over the last 7 days/)).toBeInTheDocument();
  });

  it("shows the first-run empty state rather than an empty axis when no day shipped", () => {
    render(<ThroughputChart rows={[]} />);
    expect(screen.getByText("Nothing shipped yet")).toBeInTheDocument();
    expect(bars()).toHaveLength(0);
  });

  it("falls back to the bare month-day when a date will not parse", () => {
    render(<ThroughputChart rows={[{ projectId: "p1", date: "not-a-date", count: 3 }]} />);
    expect(screen.getByText("-date")).toBeInTheDocument();
  });
});
