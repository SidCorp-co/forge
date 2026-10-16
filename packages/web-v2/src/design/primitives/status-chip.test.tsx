// @vitest-environment jsdom
//
// ISS-1228 round 8 — a session chip's mark says which state it is in: a quiet session wore the
// working chip's sparkle over a session nobody had heard from.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusChip } from "./status-chip";

afterEach(cleanup);

/** The mark a chip draws: its SVG's drawing, which differs from one icon to another. */
function markOf(status: "running" | "zombie" | "blocked"): string {
  const { container } = render(<StatusChip domain="session" status={status} />);
  const svg = container.querySelector("svg");
  const drawing = svg ? [...svg.children].map((c) => c.outerHTML).join("") : "";
  cleanup();
  return drawing;
}

describe("a session chip's mark (ISS-1228 criterion 50)", () => {
  it("gives a quiet session a mark of its own, not the working chip's", () => {
    const working = markOf("running");
    const quiet = markOf("zombie");
    expect(working).not.toBe("");
    expect(quiet).not.toBe("");
    expect(quiet).not.toBe(working);
  });

  it("gives a blocked session a mark of its own too", () => {
    const blocked = markOf("blocked");
    expect(blocked).not.toBe(markOf("running"));
    expect(blocked).not.toBe(markOf("zombie"));
  });

  it("pulses only the working chip's mark", () => {
    const { container } = render(<StatusChip domain="session" status="zombie" />);
    expect(container.querySelector("svg")?.getAttribute("class") ?? "").not.toMatch(/forge-pulse/);
  });
});
