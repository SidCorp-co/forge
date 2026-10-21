// @vitest-environment jsdom
//
// ISS-1229 r25, the master's read of the after-shots: with one issue created in twelve weeks the flow
// chart drew a block filling half the band, and its backlog line ran along the frame's edges.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LINE_STRIP_HEIGHT, STREAM_SCALE_FLOOR, StreamBand } from "./stream-band";

afterEach(cleanup);

const quiet = Array.from({ length: 12 }, (_, i) => ({
  key: `w${i}`,
  inbound: i === 11 ? 1 : 0,
  outbound: 0,
  line: i === 11 ? 1 : 0,
}));

function draw() {
  render(
    <StreamBand weeks={quiet} inboundLabel="Created" outboundLabel="Finished" lineLabel="Backlog" label="flow" />,
  );
  return document.querySelector("svg") as SVGSVGElement;
}

describe("the flow band", () => {
  it("scales one issue against the floor, so it never fills half the band", () => {
    const svg = draw();
    const heights = [...svg.querySelectorAll("rect[fill]")].map((r) => Number(r.getAttribute("height")));
    const half = 120 / 2 - 2;
    expect(STREAM_SCALE_FLOOR).toBeGreaterThanOrEqual(4);
    expect(Math.max(...heights)).toBeGreaterThan(0);
    expect(Math.max(...heights)).toBeLessThanOrEqual(half / 4);
  });

  // Round 27, judge-77: the line's zero sat at the band's bottom edge while the blocks' zero is the
  // midline, so a backlog of 0 or 1 was drawn under the axis, inside Finished, and read as negative.
  it("draws the backlog in a strip of its own, where a level of 0 sits on that strip's zero", () => {
    const svg = draw();
    expect(svg.querySelector("path")).toBeNull();
    const strip = document.querySelector("[data-stream-line-strip]") as SVGSVGElement;
    expect(strip).not.toBeNull();
    const zero = Number(strip.querySelector("[data-line-zero]")?.getAttribute("y1"));
    const ys = pathYs(strip);
    expect(ys).toHaveLength(12);
    for (const y of ys.slice(0, 11)) expect(y).toBe(zero);
    expect(ys[11]).toBeLessThan(zero);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(zero).toBeLessThanOrEqual(LINE_STRIP_HEIGHT);
  });

  it("says the strip's scale, from 0 at its baseline to the level its top stands for", () => {
    draw();
    const scale = document.querySelector("[data-line-scale]");
    expect([...(scale?.children ?? [])].map((c) => c.textContent)).toEqual([
      String(STREAM_SCALE_FLOOR),
      "0",
    ]);
  });

  it("keeps the band's blocks under its clip", () => {
    const svg = draw();
    const plot = svg.querySelector("[data-stream-plot]");
    expect(plot?.getAttribute("clip-path")).toMatch(/^url\(#.+\)$/);
    expect(plot?.querySelectorAll("rect[fill]").length).toBe(24);
  });
});

function pathYs(root: Element): number[] {
  const d = root.querySelector("path")?.getAttribute("d") ?? "";
  return [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
}
