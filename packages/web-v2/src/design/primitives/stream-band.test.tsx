// @vitest-environment jsdom
//
// ISS-1229 r25, the master's read of the after-shots: with one issue created in twelve weeks the flow
// chart drew a block filling half the band, and its backlog line ran along the frame's edges.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STREAM_SCALE_FLOOR, StreamBand } from "./stream-band";

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

  it("keeps the backlog line inside the band and draws it under the band's clip", () => {
    const svg = draw();
    const path = svg.querySelector("path")?.getAttribute("d") ?? "";
    const ys = [...path.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(120);
    const plot = svg.querySelector("[data-stream-plot]");
    expect(plot?.getAttribute("clip-path")).toMatch(/^url\(#.+\)$/);
    expect(plot?.contains(svg.querySelector("path"))).toBe(true);
  });
});
