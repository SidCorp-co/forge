import { forecastWait, RULE, say, verbatim, waitingOn } from "@/test/said";
import type { ForecastBasis, ForecastLate, ForecastPaused, ForecastRange, RequirementForecasts, ScopeForecast } from "@forge/contracts/forecast";
import { describe, expect, it } from "vitest";
import type { NeedsYouItem } from "@/features/needs-you/types";
import { baNeedsYou, feedbackFigures, landsThisWeek, lateRows, planRows, requirementsByState } from "./ba-derive";

// Wednesday 7 Oct 2026, 12:00 UTC
const NOW = Date.parse("2026-10-07T12:00:00Z");
const clock = { lang: "en" as const, now: NOW, timeZone: "UTC" };
const stamp = { label: "forecast" as const, asOf: new Date(NOW).toISOString() };
const basis: ForecastBasis = { n: 20, floor: 10, windowDays: 60, complexity: null, cycleP50Minutes: 60, cycleP85Minutes: 90, throughputPerDay: 1, concurrency: 1, concurrencyBasis: "t" };

const range = (p50: string, late: ForecastLate | null = null): ForecastRange => ({ ...stamp, kind: "forecast", p50At: p50, p85At: p50, p50Minutes: 1, p85Minutes: 1, ahead: 0, aheadKeys: [], waitsOn: [], basis, late });
const paused = (late: ForecastLate | null): ForecastPaused => ({ ...stamp, kind: "paused", ...forecastWait(say("standing.who.holderOf", { perm: "project.write" }), say("issues.standing.act.answer"), RULE), ref: null, since: null, late });

const scope = (key: string, forecast: ForecastRange | ForecastPaused): ScopeForecast => ({
  ...stamp, scope: "requirement", key, progress: { total: 2, shipped: 0, awaitingRelease: 0, toDo: 2 }, forecast, next: null, title: `Title ${key}`,
  delivery: { ...stamp, landing: forecast, release: null, inHands: null, shipped: null },
});
const reqs = (...s: ScopeForecast[]): RequirementForecasts => ({ ...stamp, projectId: "p", requirements: s });
const inputs = (s: RequirementForecasts) => ({ slug: "hop", requirements: s, feedback: undefined, feedbackTitles: new Map(), release: { summary: undefined, scope: undefined } });

describe("the BA dashboard", () => {
  it("lists what lands this week: an item due Friday, not one due next Monday", () => {
    const rows = planRows(inputs(reqs(scope("REQ-1", range("2026-10-09T15:00:00Z")), scope("REQ-2", range("2026-10-12T09:00:00Z")))), clock);
    expect(landsThisWeek(rows, clock).map((r) => r.key)).toEqual(["REQ-1"]);
  });

  it("holds the week to the viewer's timezone: Sunday night in Ho Chi Minh is still this week, Monday 00:30 is not", () => {
    const tz = { ...clock, timeZone: "Asia/Ho_Chi_Minh" };
    // 2026-10-11 16:30Z is Sun 23:30 (+7); 2026-10-11 17:30Z is Mon 00:30 (+7)
    const rows = planRows(inputs(reqs(scope("REQ-1", range("2026-10-11T16:30:00Z")), scope("REQ-2", range("2026-10-11T17:30:00Z")))), tz);
    expect(landsThisWeek(rows, tz).map((r) => r.key)).toEqual(["REQ-1"]);
  });

  it("leaves a paused item out of the week (no time) but shows it late, with who it waits on", () => {
    const late: ForecastLate = { reason: "waiting_over_day", since: "2026-10-06T00:00:00Z", byMinutes: 360 };
    const rows = planRows(inputs(reqs(scope("REQ-3", paused(late)), scope("REQ-4", range("2026-10-08T10:00:00Z", { reason: "p85_passed", since: "x", byMinutes: 90 })))), clock);
    expect(landsThisWeek(rows, clock).map((r) => r.key)).toEqual(["REQ-4"]);
    expect(lateRows(rows).map((r) => [r.key, r.late?.byMinutes])).toEqual([["REQ-3", 360], ["REQ-4", 90]]);
    expect(rows.find((r) => r.key === "REQ-3")?.eta).toMatchObject({ kind: "waits", who: say("standing.who.holderOf", { perm: "project.write" }) });
  });

  it("reads the release an item waits on, and who cuts it, from its delivery forecast", () => {
    const f = range("2026-10-08T10:00:00Z");
    const approver = say("standing.who.holderOf", { perm: "releases.approve" });
    const leg = { kind: "person" as const, mode: "approval" as never, ...forecastWait(approver, say("standing.act.cutThenApprove", { v: "0.1.0" }), RULE), version: "0.1.0", holders: [] };
    const base = scope("REQ-1", f);
    const waits: ScopeForecast = { ...base, delivery: base.delivery && { ...base.delivery, release: leg } };
    const free = scope("REQ-2", f);
    const rows = planRows(inputs(reqs(waits, free)), clock);
    expect(rows.find((r) => r.key === "REQ-1")?.release).toEqual({ version: "0.1.0", who: approver });
    expect(rows.find((r) => r.key === "REQ-2")?.release).toBeNull();
  });

  it("calls nothing late that core did not", () => {
    expect(lateRows(planRows(inputs(reqs(scope("REQ-1", range("2026-10-08T10:00:00Z")))), clock))).toEqual([]);
  });

  it("keeps issue, contract and automation rows off the dashboard's Needs you, and the workflow approval on it", () => {
    const wait = waitingOn("you", { who: say("standing.who.you"), act: verbatim("a"), rule: RULE });
    const item = (area: NeedsYouItem["area"], entity: NeedsYouItem["entity"], key: string): NeedsYouItem => ({ area, entity, key, title: key, titleLang: null, waitingOn: wait, touchedAt: null, says: { title: verbatim(key) } });
    const kept = baNeedsYou([
      item("issues", "issue", "ISS-120"),
      item("designs", "workflow", "hop-staff-shell-ux"),
      item("requirements", "requirement", "REQ-1"),
      item("contracts", "contract", "c"),
      item("automation", "schedule", "s"),
      item("feedback", "feedback", "FB-1"),
      item("releases", "release", "0.1.0"),
    ]);
    expect(kept.map((n) => n.key)).toEqual(["hop-staff-shell-ux", "REQ-1", "FB-1", "0.1.0"]);
  });

  it("counts requirements by state in lifecycle order, and feedback open, untriaged and aging", () => {
    const r = (state: string) => ({ standing: { state } }) as never;
    expect(requirementsByState([r("draft"), r("in_delivery"), r("in_delivery")]).map((x) => `${x.state}:${x.count}`)).toEqual(["draft:1", "agreed:0", "in_delivery:2", "delivered:0", "accepted:0"]);
    expect(requirementsByState([r("deferred")]).at(-1)).toEqual({ state: "deferred", count: 1 });
    const f = (phase: string, daysOld: number) => ({ phase, createdAt: new Date(NOW - daysOld * 86_400_000).toISOString() }) as never;
    expect(feedbackFigures([f("new", 9), f("triaged", 2), f("verified", 30), f("declined", 30), f("reopened", 8)], NOW)).toEqual({ open: 3, untriaged: 2, aging: 2 });
  });
});
