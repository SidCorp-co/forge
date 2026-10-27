// @vitest-environment jsdom
//
// The throughput chart draws the server's calendar, never an axis rebuilt from the rows (ISS-1149).
//
// The defect showed only in a week holding a zero day, so the fixture holds one in the middle, on
// Saturday 2026-09-19 as measured: a week in which every day shipped could not have failed against
// the chart this replaced. The malformed cases are the sparse shape the old server sent.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThroughputRow } from "@/features/runs/types";
import { Throughput, ThroughputChart } from "./throughput";

expect.extend(matchers);
afterEach(cleanup);

const row = (date: string, count: number): ThroughputRow => ({ projectId: "p1", date, count });

const WEEK: ThroughputRow[] = [
  row("2026-09-21", 27),
  row("2026-09-15", 31),
  row("2026-09-19", 0),
  row("2026-09-17", 31),
  row("2026-09-16", 62),
  row("2026-09-20", 55),
  row("2026-09-18", 11),
];

const IN_ORDER = [...WEEK].sort((a, b) => a.date.localeCompare(b.date));

const bars = () => Array.from(document.querySelectorAll("span[title]")) as HTMLElement[];
const counts = () => screen.queryAllByTestId("throughput-count").map((n) => n.textContent);
const days = () => screen.queryAllByTestId("throughput-day").map((n) => n.textContent);

describe("ThroughputChart — seven calendar days, a zero day in place (ISS-1149)", () => {
  it("labels seven consecutive days in date order, Saturday's zero day included", () => {
    render(<ThroughputChart rows={WEEK} />);
    expect(days()).toEqual(["Tue15", "Wed16", "Thu17", "Fri18", "Sat19", "Sun20", "Mon21"]);
  });

  it("draws the zero day at zero height in its own place and scales the rest to the busiest", () => {
    render(<ThroughputChart rows={WEEK} />);
    const heights = bars().map((b) => b.style.height);
    expect(heights[4]).toBe("0%");
    expect(heights[1]).toBe("100%");
    expect(heights[3]).toBe(`${(11 / 62) * 100}%`);
  });

  it("prints every bar's count as visible text, the zero included", () => {
    render(<ThroughputChart rows={WEEK} />);
    expect(counts()).toEqual(["31", "62", "31", "11", "0", "55", "27"]);
  });

  it("sums exactly the bars drawn into the caption", () => {
    render(<ThroughputChart rows={WEEK} />);
    expect(screen.getByText("217")).toBeInTheDocument();
    expect(screen.getByText(/finished over the last 7 days/)).toBeInTheDocument();
  });

  it("draws a week in which nothing shipped as seven zero bars", () => {
    render(<ThroughputChart rows={WEEK.map((r) => ({ ...r, count: 0 }))} />);
    expect(bars().map((b) => b.style.height)).toEqual(Array(7).fill("0%"));
    expect(counts()).toEqual(Array(7).fill("0"));
  });

  it("keeps a single shipped issue visible beside a busy day", () => {
    render(<ThroughputChart rows={WEEK.map((r) => (r.date === "2026-09-18" ? { ...r, count: 1 } : r))} />);
    expect(bars()[3]?.style.height).toBe("4%");
  });
});

describe("ThroughputChart — a series that is not seven consecutive days is refused", () => {
  const refused = (rows: ThroughputRow[], reason: RegExp) => {
    render(<ThroughputChart rows={rows} />);
    expect(screen.getByText("Throughput can't be drawn")).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(bars()).toHaveLength(0);
  };

  it("refuses the old sparse shape, the zero day missing and the window slid a day back", () => {
    refused([row("2026-09-14", 13), ...WEEK.filter((r) => r.count > 0)], /2026-09-18 is followed by 2026-09-20/);
  });

  it("refuses a short series", () => {
    refused(IN_ORDER.slice(1), /Expected 7 consecutive days, received 6/);
  });

  it("refuses no rows at all", () => {
    refused([], /Expected 7 consecutive days, received 0/);
  });

  it("refuses a gap inside seven rows", () => {
    refused([...IN_ORDER.slice(0, 6), row("2026-09-23", 1)], /2026-09-20 is followed by 2026-09-23/);
  });

  it("refuses a duplicated date", () => {
    refused([...IN_ORDER.slice(1), row("2026-09-21", 1)], /2026-09-21 is followed by 2026-09-21/);
  });

  it("refuses a date that is not a calendar date", () => {
    refused([...IN_ORDER.slice(1), row("2026-02-30", 1)], /"2026-02-30" is not a calendar date/);
  });
});

describe("Throughput — the tile around the chart (ISS-1154)", () => {
  const mount = (over: Partial<Parameters<typeof Throughput>[0]> = {}) =>
    render(<Throughput rows={WEEK} isLoading={false} error={null} onRetry={vi.fn()} {...over} />);

  it("draws the week once it has arrived", () => {
    mount();
    expect(counts()).toEqual(["31", "62", "31", "11", "0", "55", "27"]);
  });

  it("draws no chart, refuses nothing and says the read is not in while the series is loading", () => {
    mount({ rows: undefined, isLoading: true });
    expect(counts()).toEqual([]);
    expect(screen.getByText("The throughput is still being read.")).toBeInTheDocument();
    expect(screen.queryByText(/nothing finished/)).toBeNull();
    expect(screen.queryByText("Throughput can't be drawn")).toBeNull();
  });

  it("names a failed read and retries it, rather than drawing a refused empty series", () => {
    const onRetry = vi.fn();
    mount({ rows: undefined, error: new Error("throughput read failed"), onRetry });
    expect(screen.getByText("Couldn't load throughput")).toBeInTheDocument();
    expect(screen.queryByText("Throughput can't be drawn")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("refuses a series that is not seven consecutive days by name", () => {
    mount({ rows: IN_ORDER.slice(1) });
    expect(screen.getByText("Throughput can't be drawn")).toBeInTheDocument();
    expect(screen.getByText(/Expected 7 consecutive days, received 6/)).toBeInTheDocument();
  });
});
