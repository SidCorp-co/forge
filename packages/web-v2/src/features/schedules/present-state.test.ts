// ISS-1163 — what a schedule row may say about the present. The failing inputs below are the
// ones the old row got wrong: a paused schedule's 17-day-old success, and a cron nobody could read.
import { describe, expect, it } from "vitest";
import {
  describeCadence,
  formatAge,
  lastRunView,
  listSum,
  STALE_RULE,
} from "./present-state";
import type { ScheduleRow } from "./types";

// Cron fires are read in the runner's zone; pin it so the boundaries below mean the same everywhere.
process.env.TZ = "UTC";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function row(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "s1",
    projectId: "p1",
    name: "Nightly",
    cron: "0 16 * * *",
    prompt: "go",
    kind: "prompt",
    script: null,
    enabled: true,
    targetProjectSlug: null,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    lastSessionId: null,
    metadata: null,
    templateKey: null,
    params: null,
    mode: null,
    appliedMessageVersions: null,
    createdAt: ago(40 * DAY),
    updatedAt: ago(40 * DAY),
    ...over,
  };
}

describe("describeCadence", () => {
  it("reads a daily and an every-2-hours cron in words and keeps the expression", () => {
    expect(describeCadence("0 16 * * *")).toEqual({ words: "At 16:00", expression: "0 16 * * *" });
    const every2 = describeCadence("0 */2 * * *");
    expect(every2.words?.toLowerCase()).toContain("every 2 hours");
    expect(every2.expression).toBe("0 */2 * * *");
  });

  it("returns no words, and still the expression, for one the translator cannot read", () => {
    expect(describeCadence("not a cron")).toEqual({ words: null, expression: "not a cron" });
  });
});

describe("formatAge", () => {
  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 minute ago"],
    [5 * 60_000, "5 minutes ago"],
    [HOUR, "1 hour ago"],
    [23 * HOUR, "23 hours ago"],
    [DAY, "1 day ago"],
    [17 * DAY, "17 days ago"],
    [-5 * HOUR, "just now"],
  ])("%d ms old reads %s", (ms, text) => {
    expect(formatAge(ago(ms), NOW)).toBe(text);
  });

  it("is null for an unparseable timestamp", () => {
    expect(formatAge("garbage", NOW)).toBeNull();
  });
});

describe("lastRunView", () => {
  it("a paused schedule's 17-day-old success is dated words, marked stale", () => {
    const v = lastRunView(
      row({ enabled: false, lastStatus: "success", lastRunAt: ago(17 * DAY) }),
      NOW,
    );
    expect(v).toEqual({ kind: "ran", text: "Succeeded 17 days ago", stale: true });
  });

  it("a paused schedule is stale even when its last run was a minute ago", () => {
    const v = lastRunView(row({ enabled: false, lastStatus: "success", lastRunAt: ago(60_000) }), NOW);
    expect(v).toMatchObject({ stale: true });
  });

  it("an enabled daily schedule's result from this morning is not stale", () => {
    const v = lastRunView(row({ lastStatus: "success", lastRunAt: ago(5 * HOUR) }), NOW);
    expect(v).toEqual({ kind: "ran", text: "Succeeded 5 hours ago", stale: false });
  });

  it("stale begins when the second run comes due after it, not the first", () => {
    // Daily 16:00 (browser zone), NOW 12:00. A result 26h old has one 16:00 behind it; 50h, two.
    const daily = (age: number) =>
      lastRunView(row({ lastStatus: "success", lastRunAt: ago(age) }), NOW);
    expect(daily(HOUR)).toMatchObject({ stale: false });
    expect(daily(26 * HOUR)).toMatchObject({ stale: false });
    expect(daily(50 * HOUR)).toMatchObject({ stale: true });
  });

  it("an hourly weekday schedule is measured against the runs it owed, not a window of fires", () => {
    // Monday 12:00; the last run was three hours ago, with only one-hour gaps between.
    const monday = new Date("2026-09-21T12:00:00.000Z");
    const v = lastRunView(
      row({ cron: "0 * * * 1-5", lastStatus: "success", lastRunAt: new Date(monday.getTime() - 3 * HOUR).toISOString() }),
      monday,
    );
    expect(v).toMatchObject({ stale: true });
    // Friday evening's last run, read on Monday morning: the weekend owed no runs, Monday owes some.
    const early = new Date("2026-09-21T00:30:00.000Z");
    const fri = lastRunView(
      row({ cron: "0 * * * 1-5", lastStatus: "success", lastRunAt: "2026-09-18T23:00:00.000Z" }),
      early,
    );
    expect(fri).toMatchObject({ stale: false });
  });

  it("a weekly schedule is not stale between its runs, and is after two weeks", () => {
    const weekly = (age: number) =>
      lastRunView(row({ cron: "0 9 * * 1", lastStatus: "success", lastRunAt: ago(age) }), NOW);
    expect(weekly(6 * DAY)).toMatchObject({ stale: false });
    expect(weekly(15 * DAY)).toMatchObject({ stale: true });
  });

  it("a failure is stated as a failure, with its age", () => {
    const v = lastRunView(row({ lastStatus: "failed", lastRunAt: ago(2 * HOUR) }), NOW);
    expect(v).toEqual({ kind: "ran", text: "Failed 2 hours ago", stale: false });
  });

  it("a running verdict reads since", () => {
    const v = lastRunView(row({ lastStatus: "running", lastRunAt: ago(3 * HOUR) }), NOW);
    expect(v).toMatchObject({ text: "Running since 3 hours ago" });
  });

  it("a schedule that never ran carries no age and no stale marker", () => {
    expect(lastRunView(row({ lastStatus: null }), NOW)).toEqual({ kind: "never" });
    expect(lastRunView(row({ enabled: false, lastStatus: null }), NOW)).toEqual({ kind: "never" });
  });

  it("an unreadable cadence makes no stale claim for an enabled schedule", () => {
    const v = lastRunView(
      row({ cron: "nope", lastStatus: "success", lastRunAt: ago(90 * DAY) }),
      NOW,
    );
    expect(v).toMatchObject({ stale: false });
  });

  it("a verdict with no timestamp says its time is unknown", () => {
    const v = lastRunView(row({ lastStatus: "success", lastRunAt: null }), NOW);
    expect(v).toEqual({ kind: "ran", text: "Succeeded, time unknown", stale: false });
  });
});

describe("listSum", () => {
  const rows = (...enabled: boolean[]) => enabled.map((e) => ({ enabled: e }));

  it("says none enabled when nothing is on", () => {
    expect(listSum(rows(false, false, false, false, false))).toBe("5 schedules · none enabled");
    expect(listSum(rows(false))).toBe("1 schedule · none enabled");
  });

  it("counts the enabled ones, and says all when all are", () => {
    expect(listSum(rows(true, false, true, false, false))).toBe("5 schedules · 2 enabled");
    expect(listSum(rows(true, true))).toBe("2 schedules · all enabled");
    expect(listSum(rows(true))).toBe("1 schedule · enabled");
  });
});

describe("STALE_RULE", () => {
  it("states the threshold the code applies", () => {
    expect(STALE_RULE).toContain("two scheduled runs");
    expect(STALE_RULE).toContain("paused");
  });
});
