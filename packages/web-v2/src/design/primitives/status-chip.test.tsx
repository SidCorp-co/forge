// @vitest-environment jsdom
//
// ISS-1228 round 8 — a session chip's mark says which state it is in: a quiet session wore the
// working chip's sparkle over a session nobody had heard from.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusKey } from "@/design/status";
import { JOB_KIND_LABEL } from "@/features/overview/job-kinds";
import { StatusChip } from "./status-chip";

afterEach(cleanup);

/** The mark a chip draws: its SVG's drawing, which differs from one icon to another. */
function markOf(status: StatusKey): string {
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

  it("gives every status a session chip can show a mark of its own, so none is told apart by colour alone", () => {
    const shown: StatusKey[] = ["running", "queued", "blocked", "waiting", "passed", "failed", "paused", "done", "archived", "zombie", "swept"];
    const marks = new Map(shown.map((s) => [s, markOf(s)]));
    expect(marks.get("done")).not.toBe(marks.get("running"));
    expect(new Set(marks.values()).size).toBe(shown.length);
  });

  it("pulses only the working chip's mark", () => {
    const { container } = render(<StatusChip domain="session" status="zombie" />);
    expect(container.querySelector("svg")?.getAttribute("class") ?? "").not.toMatch(/forge-pulse/);
  });
});

// ISS-1228 r9: a step now reads in words, and the chip cut "running · Issue work" at sixteen characters.
describe("a running chip's step", () => {
  it("has room for every kind of work's words, whole", () => {
    for (const words of Object.values(JOB_KIND_LABEL)) {
      const { container } = render(<StatusChip domain="session" status="running" stage={words} />);
      const text = container.querySelector("[title]") as HTMLElement;
      expect(text.textContent, "the status in words, not its stored key").toBe(`Running · ${words}`);
      const room = Number(/max-w-\[(\d+)ch\]/.exec(text.className)?.[1] ?? Number.POSITIVE_INFINITY);
      expect(room, `"${text.textContent}" is cut at ${room} characters`).toBeGreaterThanOrEqual(text.textContent?.length ?? 0);
      cleanup();
    }
  });
});
