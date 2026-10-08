// The chart, timeline and flow renderers. What must hold: each draws the data it was given and only
// that (axis marks at values the data reaches, a time axis from the first date to the last, nodes and
// links the block names), names its axes and legend from the block, carries the contract's text as an
// alternative, and a block it cannot place to scale is named, never guessed at.

import { blockToText, type VisualBlock } from "@forge/contracts/visual-blocks";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VisualBlockProvider, VisualBlockView } from ".";
import { chartModel } from "./chart-model";
import { timelineModel } from "./timeline-model";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// jsdom lays nothing out, so recharts' container reads 0 by 0 and draws nothing; this observer reports
// the 480 by 240 the chart is given, as a browser's would.
beforeEach(() => {
  // and measures every string as 0 wide, which recharts reads as "no room" and drops each tick label
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: 24, height: 12, top: 0, left: 0, right: 24, bottom: 12, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  // and no DOMMatrixReadOnly, which the flow canvas reads its zoom from
  vi.stubGlobal("DOMMatrixReadOnly", class { m22 = 1; });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(target: Element) {
        this.cb([{ target, contentRect: { width: 480, height: 240 } } as unknown as ResizeObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

const frame = {
  fields: [
    { name: "week", type: "string", label: "Week" },
    { name: "day", type: "date", label: "Day" },
    { name: "team", type: "string", label: "Team" },
    { name: "left", type: "number", label: "Points left", unit: "pts" },
    { name: "done", type: "number", label: "Done" },
    { name: "lead", type: "duration", label: "Lead time" },
    { name: "start", type: "date", label: "Start" },
    { name: "end", type: "date", label: "End" },
    { name: "p50", type: "date", label: "P50" },
    { name: "p85", type: "date", label: "P85" },
  ],
  rows: [
    { week: "W1", day: "2026-10-01T00:00:00Z", team: "A", left: 40, done: 2, lead: 3600000, start: "2026-10-01T00:00:00Z", end: "2026-10-10T00:00:00Z", p50: "2026-10-12T00:00:00Z", p85: "2026-10-20T00:00:00Z" },
    { week: "W2", day: "2026-10-02T00:00:00Z", team: "A", left: 30, done: 9, lead: 7200000, start: "2026-10-05T00:00:00Z", end: null, p50: null, p85: null },
    { week: "W3", day: "2026-10-08T00:00:00Z", team: "A", left: 12, done: 4, lead: null, start: null, end: null, p50: null, p85: null },
  ],
};
const base = { v: 1, source: { runId: "run-9" }, frame };
// each block names its run's query and read time, as the message that carries it stored them
const facts = { queryId: "progress-by-requirement", asOf: "2026-10-08T09:30:00.000Z" };
const show = (block: unknown) =>
  render(
    <VisualBlockProvider value={{ projectSlug: undefined, sourceFacts: () => facts }}>
      <VisualBlockView block={block} />
    </VisualBlockProvider>,
  );
const alt = () => screen.getByTestId("visual-block-alt").textContent;

describe("chart block", () => {
  const bar = { ...base, kind: "chart", variant: "bar", x: "week", y: ["done"], title: "Done by week" };

  it("draws a bar chart of the frame's rows with the axes named from the block", () => {
    show(bar);
    expect(screen.getByTestId("chart-block").getAttribute("data-variant")).toBe("bar");
    expect(screen.getByText("Done by week")).toBeTruthy();
    expect(screen.getByText("Week")).toBeTruthy();
    expect(screen.getAllByText("Done").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".recharts-bar-rectangle").length).toBe(3);
  });

  it("marks the value axis only at values the data reaches: zero and the highest", () => {
    const model = chartModel(bar as never);
    if ("unsupported" in model) throw new Error(model.unsupported);
    expect(model.domain).toEqual([0, 9]);
    expect(model.yTicks).toEqual([0, 9]);
    show(bar);
    const ticks = [...document.querySelectorAll(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value")].map((t) => t.textContent);
    expect(ticks).toEqual(["0", "9"]);
  });

  it("colours its axes, labels and marks from theme tokens, none from a fixed colour", () => {
    show({ ...bar, series: undefined });
    const svg = document.querySelector(".recharts-surface")?.outerHTML ?? "";
    expect(svg).toContain("var(--fg-muted)");
    expect(svg).not.toMatch(/(?:fill|stroke)="#[0-9a-f]{3,6}"/i);
  });

  it("starts at zero though every value is high, so bar heights keep their proportion", () => {
    const m = chartModel({ ...bar, y: ["left"], frame: { ...frame, rows: frame.rows.slice(0, 2) } } as never);
    if ("unsupported" in m) throw new Error(m.unsupported);
    expect(m.domain).toEqual([0, 40]);
  });

  it("reaches below zero when the data does", () => {
    const m = chartModel({ ...bar, frame: { ...frame, rows: [{ ...frame.rows[0], done: -5 }, { ...frame.rows[1], done: 3 }] } } as never);
    if ("unsupported" in m) throw new Error(m.unsupported);
    expect(m.domain).toEqual([-5, 3]);
    expect(m.yTicks).toEqual([-5, 0, 3]);
  });

  it("draws a line chart in a single series, coloured from the theme tokens", () => {
    show({ ...base, kind: "chart", variant: "line", x: "week", y: ["done"] });
    expect(screen.getByTestId("chart-block").getAttribute("data-variant")).toBe("line");
    expect(screen.queryByTestId("chart-legend")).toBeNull();
    expect(document.querySelectorAll(".recharts-line").length).toBe(1);
    // the chart's own style sheet, wherever another component's sheet sits before it in the document
    expect([...document.querySelectorAll("style")].map((st) => st.textContent).join("\n")).toContain("var(--chart-1)");
  });

  it("splits by the series field and names each series in the legend", () => {
    const f = {
      fields: frame.fields.slice(0, 5),
      rows: [
        { week: "W1", day: null, team: "A", left: null, done: 2 },
        { week: "W1", day: null, team: "B", left: null, done: 5 },
        { week: "W2", day: null, team: "A", left: null, done: 4 },
        { week: "W2", day: null, team: "B", left: null, done: 1 },
      ],
    };
    show({ ...base, frame: f, kind: "chart", variant: "line", x: "week", y: ["done"], series: "team" });
    const legend = screen.getByTestId("chart-legend");
    expect(within(legend).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["A", "B"]);
    expect(document.querySelectorAll(".recharts-line").length).toBe(2);
  });

  it("draws a burndown over a time axis from the first date to the last", () => {
    const b = { ...base, kind: "chart", variant: "burndown", x: "day", y: ["left"] };
    const m = chartModel(b as never);
    if ("unsupported" in m) throw new Error(m.unsupported);
    expect(m.scale).toBe("time");
    expect(m.xTicks).toEqual([Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-02T00:00:00Z"), Date.parse("2026-10-08T00:00:00Z")]);
    show(b);
    expect(screen.getByTestId("chart-block").getAttribute("data-scale")).toBe("time");
    expect(screen.getByText("Points left (pts)")).toBeTruthy();
  });

  it("carries the contract's text as its alternative and hides the drawing from assistive technology", () => {
    show(bar);
    expect(alt()).toBe(blockToText(bar as unknown as VisualBlock));
    expect(alt()).toContain("Bar chart of Done by Week");
    expect(document.querySelector("[aria-hidden='true'] .recharts-wrapper")).toBeTruthy();
  });

  it("names a chart whose rows cannot be placed to scale, with the reason, and still gives the text", () => {
    const dup = { ...bar, variant: "line", x: "day", frame: { ...frame, rows: [frame.rows[0], { ...frame.rows[0] }] } };
    show(dup);
    expect(screen.getByTestId("visual-block-unsupported").textContent).toBe(
      "This answer has a chart block this screen cannot show: Day 2026-10-01 appears twice.",
    );
    expect(alt()).toContain("Line chart");
  });

  it("refuses value fields that differ in unit rather than put them on one scale", () => {
    const m = chartModel({ ...bar, y: ["done", "lead"] } as never);
    expect(m).toEqual({ unsupported: "its value fields differ in kind or unit, so they cannot share one scale" });
  });

  it("refuses a malformed chart block by name: a text field cannot be a value", () => {
    show({ ...bar, y: ["team"] });
    expect(screen.getByTestId("visual-block-refused").textContent).toContain('"team" is string, but this needs number or duration');
  });
});

describe("timeline block", () => {
  const tl = { ...base, kind: "timeline", label: "week", start: "start", end: "end", p50: "p50", p85: "p85", title: "Roadmap" };

  it("places each item on one time axis that runs from the earliest date to the latest", () => {
    const m = timelineModel(tl as never);
    expect(m.minText).toBe("2026-10-01");
    expect(m.maxText).toBe("2026-10-20");
    expect(m.undated).toEqual(["W3"]);
    show(tl);
    const spans = screen.getAllByTestId("timeline-span") as HTMLElement[];
    expect(spans).toHaveLength(2);
    // 1 Oct to 10 Oct of a 19-day axis: starts at 0, ends at 9/19
    expect(spans[0]?.style.left).toBe("0%");
    expect(Number.parseFloat(spans[0]?.style.width ?? "")).toBeCloseTo((9 / 19) * 100, 2);
    // 5 Oct with no end is a point: starts at 4/19 and has no width of its own
    expect(Number.parseFloat(spans[1]?.style.left ?? "")).toBeCloseTo((4 / 19) * 100, 2);
    expect(Number.parseFloat(spans[1]?.style.width ?? "")).toBe(0);
    expect(screen.getByTestId("timeline-axis").textContent).toBe("2026-10-012026-10-20");
  });

  it("draws the forecast from p50 to p85 and says so in the legend", () => {
    show(tl);
    const f = screen.getByTestId("timeline-forecast") as HTMLElement;
    expect(Number.parseFloat(f.style.left)).toBeCloseTo((11 / 19) * 100, 2);
    expect(Number.parseFloat(f.style.width)).toBeCloseTo((8 / 19) * 100, 2);
    expect(within(screen.getByTestId("timeline-legend")).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Planned", "Forecast, p50 to p85"]);
  });

  it("lists an item with no date instead of placing it", () => {
    show(tl);
    expect(screen.getByTestId("timeline-undated").textContent).toBe("No date in the data for: W3.");
  });

  it("groups by lane and carries the text alternative", () => {
    show({ ...tl, lane: "team" });
    expect(screen.getAllByText("A")).toHaveLength(1);
    expect(alt()).toBe(blockToText({ ...tl, lane: "team" } as unknown as VisualBlock));
  });

  it("refuses a timeline whose end has no start, by name", () => {
    show({ ...tl, start: undefined, p50: undefined, p85: undefined });
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("timeline block");
  });
});

describe("flow block", () => {
  const flow = {
    v: 1,
    kind: "flow",
    title: "Triage",
    nodes: [
      { id: "a", label: "Report arrives" },
      { id: "b", label: "Is it a defect?" },
      { id: "c", label: "File an issue" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c", label: "yes" },
    ],
  };

  it("draws the nodes and links the block names, laid out", async () => {
    show(flow);
    await waitFor(() => expect(screen.getAllByTestId("flow-node")).toHaveLength(3));
    expect(screen.getAllByTestId("flow-node").map((n) => n.textContent)).toEqual(["Report arrives", "Is it a defect?", "File an issue"]);
    await waitFor(() => expect(document.querySelectorAll(".react-flow__edge").length).toBe(2));
    expect(screen.getByTestId("flow-edge-label").textContent).toBe("yes");
  });

  it("carries the contract's text as its alternative", () => {
    show(flow);
    expect(alt()).toBe(blockToText(flow as unknown as VisualBlock));
    expect(alt()).toContain("Is it a defect? -> File an issue (yes)");
  });

  it("draws a node with no link", async () => {
    show({ ...flow, edges: [] });
    await waitFor(() => expect(screen.getAllByTestId("flow-node")).toHaveLength(3));
  });

  it("refuses an edge to a node that does not exist, naming it", () => {
    show({ ...flow, edges: [{ from: "a", to: "zzz" }] });
    expect(screen.getByTestId("visual-block-refused").textContent).toContain('"zzz" is not a node id');
  });

  it("refuses a label that carries markup", () => {
    show({ ...flow, nodes: [{ id: "a", label: "<b>x</b>" }], edges: [] });
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("a label is plain text");
  });
});
