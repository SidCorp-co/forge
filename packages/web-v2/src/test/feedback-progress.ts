// One feedback item's progress as core answers it (`GET …/forecast/feedback/:fb`), built for the
// screens that draw it: the unit test, the vi walking test and the witness. Who and what an act is
// are said by their registry keys, as core says them.

import type { FeedbackEstimate, FeedbackForecast, FeedbackProgress, FeedbackWork } from "@forge/contracts/forecast";
import { forecastWait, say } from "./said";

export const PROGRESS_AT = "2026-10-16T09:00:00.000Z";
const stamp = { label: "forecast" as const, asOf: PROGRESS_AT };

/** Who triages an untriaged item, as the forecast's triage wait names them. */
export const TRIAGER = forecastWait(say("standing.who.holderOf", { perm: "feedback.approve" }), say("standing.act.triageIt"), say("feedback.rule.triagerTriages", { phase: "new" }));
/** Who cuts the release a landed fix waits on. */
export const CUTTER = forecastWait(say("standing.who.named", { name: "Dana Lee" }), say("standing.act.cut", { v: "0.4.0", more: null }), say("forecast.reason.manual"));

export const work = (over: Partial<FeedbackWork> = {}): FeedbackWork => ({
  state: "untriaged",
  running: 0,
  total: 0,
  requirement: null,
  duplicateOf: null,
  issues: [],
  ...over,
});

const none = (reason: Extract<FeedbackEstimate, { kind: "none" }>["reason"], over: Partial<Extract<FeedbackEstimate, { kind: "none" }>> = {}): FeedbackEstimate => ({
  kind: "none",
  reason,
  waits: null,
  history: null,
  until: null,
  ...over,
});

export const progress = (key: string, w: FeedbackWork, estimate: FeedbackEstimate, forecast: Partial<FeedbackForecast> = {}): FeedbackProgress => ({
  ...stamp,
  key,
  work: w,
  estimate,
  forecast: { key, triage: null, delivery: null, ...forecast },
});

const triagePaused = {
  ...stamp,
  kind: "paused" as const,
  ...TRIAGER,
  ref: null,
  since: null,
  late: null,
};

const landedWaitingOnCut = {
  ...stamp,
  landing: { ...stamp, kind: "landed" as const, landedAt: PROGRESS_AT },
  release: { kind: "person" as const, mode: "manual" as const, ...CUTTER, version: "0.4.0", holders: [] },
  inHands: null,
  shipped: null,
};

const P50 = "2026-10-17T14:00:00.000Z";
const P85 = "2026-10-19T10:00:00.000Z";
const inFlight = {
  ...stamp,
  landing: {
    ...stamp,
    kind: "forecast" as const,
    anchoredAt: PROGRESS_AT,
    confidence: { level: "medium" as const, n: 12, spread: 0.5 },
    p50At: P50,
    p85At: P85,
    p50Minutes: 1740,
    p85Minutes: 4380,
    ahead: 0,
    aheadKeys: [],
    waitsOn: [],
    basis: { n: 45, floor: 10, windowDays: 60, complexity: null, cycleP50Minutes: 35, cycleP85Minutes: 240, throughputPerDay: 12.4, concurrency: 2, concurrencyBasis: "held to 2" },
    late: null,
  },
  release: null,
  inHands: null,
  shipped: null,
};

const ISSUES = [
  { key: "ISS-41", title: "Luu the khi keo", status: "in_progress" },
  { key: "ISS-42", title: "Luu cot", status: "open" },
];

/** One of each: every work state an item reads at, and every reason core gives for no date. */
export const PROGRESS_CASES: FeedbackProgress[] = [
  progress("FB-11", work(), none("untriaged", { waits: TRIAGER.says }), { triage: triagePaused }),
  progress("FB-12", work({ state: "running", running: 1, total: 2, issues: ISSUES }), { kind: "dated", p50At: P50, p85At: P85, of: "landing" }, { delivery: inFlight }),
  progress("FB-20", work({ state: "queued", total: 1, issues: [{ key: "ISS-47", title: "Them nut", status: "open" }] }), none("history", { history: { n: 3, floor: 10 } })),
  progress("FB-13", work({ state: "landed", total: 1, issues: [{ key: "ISS-43", title: "Sua bo loc", status: "awaiting_release" }] }), none("release_waits", { waits: CUTTER.says }), { delivery: landedWaitingOnCut }),
  progress("FB-14", work({ state: "no_issues", requirement: { key: "REQ-7", title: "Bo loc giu thu tu", status: "draft" } }), none("no_issues")),
  progress("FB-15", work({ state: "no_work" }), none("no_work")),
  progress("FB-16", work({ state: "shipped", total: 1, issues: [{ key: "ISS-44", title: "Sua tai lai", status: "closed" }] }), { kind: "shipped", version: "0.3.0", at: PROGRESS_AT }),
  progress("FB-17", work({ state: "parked", total: 1, duplicateOf: "FB-3", issues: [{ key: "ISS-45", title: "Cho thiet ke", status: "on_hold" }] }), none("waits", { waits: CUTTER.says })),
  progress("FB-18", work(), none("snoozed", { until: "2026-10-20T09:00:00.000Z" })),
  progress("FB-19", work({ state: "ended", issues: [{ key: "ISS-46", title: "Bo", status: "dropped" }] }), none("ended")),
];
