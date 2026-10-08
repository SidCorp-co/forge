import { OPEN_WORK_STATES, WORK_STATE_LABELS } from "@forge/contracts/work-state";
import { describe, expect, it } from "vitest";
import {
  type AttentionActionKind,
  attentionCaption,
  conicGradient,
  type DashboardAttentionItem,
  statusDonut,
} from "./derive";

const WORK = {
  open: 56,
  in_flight: 11,
  awaiting_release: 1,
  blocked_on_person: 4,
  draft: 24,
  finished: 1306,
};

describe("statusDonut (ISS-1156)", () => {
  it("draws a legend row for every open state that holds an issue, worded as the state is", () => {
    const { segments } = statusDonut(WORK);
    expect(segments.map((s) => [s.key, s.label, s.count])).toEqual([
      ["open", "Open, not picked up", 56],
      ["in_flight", "In flight", 11],
      ["awaiting_release", "Awaiting release", 1],
      ["blocked_on_person", "Blocked on a person", 4],
    ]);
  });

  it("adds the legend up to the figure at the ring's centre, so no slice is left unnamed", () => {
    const { segments, total } = statusDonut(WORK);
    expect(segments.reduce((n, s) => n + s.count, 0)).toBe(total);
    expect(total).toBe(72);
    expect(segments.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 6);
  });

  it("leaves drafts and finished work out of the ring and the figure, whatever their count", () => {
    const { segments, total } = statusDonut({ ...WORK, draft: 9999, finished: 9999 });
    expect(total).toBe(72);
    expect(segments.map((s) => s.key)).not.toContain("draft");
    expect(segments.map((s) => s.key)).not.toContain("finished");
  });

  it("leaves out a state with no issue in it rather than drawing an empty slice", () => {
    const { segments } = statusDonut({ ...WORK, awaiting_release: 0 });
    expect(segments.map((s) => s.key)).toEqual(["open", "in_flight", "blocked_on_person"]);
  });

  it("is empty, not zero-filled, for a project holding nothing open", () => {
    expect(statusDonut({ ...WORK, open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0 })).toEqual({
      segments: [],
      total: 0,
    });
    expect(statusDonut(undefined)).toEqual({ segments: [], total: 0 });
  });

  it("names its states with the words of the one vocabulary", () => {
    expect(statusDonut(WORK).segments.map((s) => s.label)).toEqual(
      OPEN_WORK_STATES.map((s) => WORK_STATE_LABELS[s]),
    );
  });

  it("colours every slice the ring draws, one stop per legend row", () => {
    const { segments } = statusDonut(WORK);
    const gradient = conicGradient(segments);
    for (const s of segments) expect(gradient).toContain(s.color);
  });
});

describe("attentionCaption (ISS-1156)", () => {
  const item = (actionKind: AttentionActionKind, i: number): DashboardAttentionItem => ({
    key: `${actionKind}-${i}`,
    actionKind,
    actionLabel: "x",
    title: "t",
    link: "/l",
  });

  it("says what the Needs you figure counts, by kind, so it is not read as Blocked on a person", () => {
    const items = [item("retry", 0), item("retry", 1), item("diff", 2), ...[3, 4, 5].map((i) => item("input", i)), item("chain", 6)];
    expect(attentionCaption(items)).toBe(
      "to act on: 2 failed jobs · 1 to review · 3 questions · 1 held by a dependency",
    );
  });

  it("adds up to the figure: the parts of the caption are the items counted", () => {
    const items = [item("retry", 0), item("input", 1), item("input", 2)];
    const parts = attentionCaption(items).replace("to act on: ", "").split(" · ");
    expect(parts.reduce((n, p) => n + Number.parseInt(p, 10), 0)).toBe(items.length);
  });

  it("leaves out a kind with nothing in it, and says so when nothing needs a person", () => {
    expect(attentionCaption([item("diff", 0)])).toBe("to act on: 1 to review");
    expect(attentionCaption([])).toBe("nothing to act on");
  });
});
