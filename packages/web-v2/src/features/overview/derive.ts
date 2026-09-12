// web-v2 feature module: workspace overview — PURE derivations over the pulse
// response. Action-queue rows and their owners, the waffle cells, the age
// strip, the flow series, the quality rates, and every figure's destination.
//
// cm:guard every function here stays PURE — no React, no clock of its own, no I/O — because each one is a rule this surface is judged on (which condition a row stands for, what order the queue reads in, where a figure's door leads) and one impure helper takes the whole module out of the reach of a test that renders nothing.

import { TONE_META } from "@/design/status";
import {
  PULSE_BUCKET_LABELS,
  PULSE_BUCKET_STATUSES,
  type PulseIssueIdentity,
  type PulseProjectIdentity,
  type PulseQuality,
  type PulseResponse,
  type PulseThresholds,
  type PulseWorkBuckets,
} from "./types";

/** Elapsed seconds as one calm phrase. */
export function formatElapsed(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type SilenceMark = "calm" | "warn" | "alarm";

/**
 * Which of the response's two marks the silence has passed.
 */
// cm:guard both marks come off `thresholds` and never off a constant here — the client marking at its own cutoff is how the dashboard starts disagreeing with the figures it draws (ISS-988 criterion 27).
export function silenceMark(
  seconds: number | null,
  thresholds: PulseThresholds,
): SilenceMark {
  if (seconds === null) return "calm";
  if (seconds >= thresholds.silenceAlarmSeconds) return "alarm";
  if (seconds >= thresholds.silenceWarnSeconds) return "warn";
  return "calm";
}

/** Where a figure's records are listed. */
export type Destination =
  | { kind: "route"; href: string }
  | { kind: "panel"; panel: PanelKey }
  | { kind: "anchor"; anchorId: string };

export type PanelKey = "liveJobs" | "stuckRuns" | ActionKey;

export const BUCKET_ORDER: Array<keyof PulseWorkBuckets> = [
  "open",
  "inProgress",
  "awaitingRelease",
  "humanBlocked",
];

const BUCKET_TONE: Record<keyof PulseWorkBuckets, keyof typeof TONE_META> = {
  open: "neutral",
  inProgress: "active",
  awaitingRelease: "success",
  humanBlocked: "attention",
};

/** The issues list URL that carries exactly the statuses a bucket counted. */
// cm:edge contract -> packages/web-v2/src/features/issues/components/issues-list-view.tsx — that view reads `?status=` through `statusesFromParam`; a separator other than the comma it splits on silently narrows to the first status alone (ISS-988 criterion 47).
export function bucketHref(slug: string, bucket: keyof PulseWorkBuckets): string {
  return `/projects/${slug}/issues?status=${PULSE_BUCKET_STATUSES[bucket].join(",")}`;
}

export interface WaffleCell {
  key: keyof PulseWorkBuckets;
  label: string;
  count: number;
  color: string;
  destination: Destination;
}

/** The four buckets as waffle categories, workspace-wide. */
export function waffleCells(buckets: PulseWorkBuckets): WaffleCell[] {
  return BUCKET_ORDER.map((key) => ({
    key,
    label: PULSE_BUCKET_LABELS[key],
    count: buckets[key],
    color: TONE_META[BUCKET_TONE[key]].dot,
    // cm:why a workspace-wide bucket spans every project, and no single issues-list URL can name that set — so its door is the per-project table below it, which breaks the same figure down into rows that each DO have an exact URL (ISS-988 criterion 39)
    destination: { kind: "anchor", anchorId: "pulse-per-project" } as const,
  }));
}

export type ActionKey =
  | "stuckRuns"
  | "abandonedIssues"
  | "releaseWaiting"
  | "neverRanProjects"
  | "silentProjects";

export type ActionOwner = "person" | "machine";

/**
 * The tie-break of last resort, so one response renders in one order.
 */
// cm:guard this tuple IS criterion 34's fixed order and the array index is read as the rank — reordering it changes what the dashboard shows without changing a figure, so it moves only with that criterion (ISS-988).
export const ACTION_ORDER: ActionKey[] = [
  "stuckRuns",
  "abandonedIssues",
  "releaseWaiting",
  "neverRanProjects",
  "silentProjects",
];

const ACTION_META: Record<ActionKey, { label: string; owner: ActionOwner; hint: string }> = {
  stuckRuns: {
    label: "Runs claimed but empty",
    owner: "machine",
    hint: "The control plane still calls these open and no job is under them.",
  },
  abandonedIssues: {
    label: "In-flight issues nobody is working",
    owner: "person",
    hint: "In progress, no live job, idle past the threshold — nothing will pick these up on its own.",
  },
  releaseWaiting: {
    label: "Waiting to be released",
    owner: "person",
    hint: "Merged and waiting on a release nobody has run.",
  },
  neverRanProjects: {
    label: "Projects holding a backlog with no pipeline",
    owner: "person",
    hint: "These have issues and have never started a run.",
  },
  silentProjects: {
    label: "Projects gone quiet",
    owner: "machine",
    hint: "A backlog, and the last run is older than the threshold.",
  },
};

export interface ActionRecord {
  key: string;
  label: string;
  detail: string;
  href: string;
  ageSeconds: number;
}

export interface ActionRow {
  key: ActionKey;
  label: string;
  hint: string;
  owner: ActionOwner;
  /** Every record the condition holds. */
  count: number;
  /** The records the response actually named — never more than `count`. */
  records: ActionRecord[];
  oldestSeconds: number;
}

const issueRecord = (i: PulseIssueIdentity): ActionRecord => ({
  key: i.documentId,
  label: i.issueRef,
  detail: i.title,
  href: `/projects/${i.projectSlug}/issues/${i.documentId}`,
  ageSeconds: i.ageSeconds,
});

const projectRecord = (p: PulseProjectIdentity, now: number): ActionRecord => ({
  key: p.id,
  label: p.name,
  detail: `${p.backlog} ${p.backlog === 1 ? "issue" : "issues"} waiting`,
  href: `/projects/${p.slug}`,
  ageSeconds: p.lastIssueRunAt
    ? Math.max(0, Math.floor((now - new Date(p.lastIssueRunAt).getTime()) / 1000))
    : Number.MAX_SAFE_INTEGER,
});

/**
 * The ranked action queue: one row per condition that has records.
 */
// cm:guard the ordering is oldest-first on the OLDEST record, then count, then `ACTION_ORDER` — three keys, because the first two tie whenever two conditions hold the same record ages, and an unstable sort there renders the same response in a different order on every refresh (ISS-988 criteria 33-34).
// cm:guard a project that has NEVER run takes the largest age rather than a zero: it is the extreme of "how long since a run", and sorting it as if it ran a moment ago buries the worst row at the bottom (ISS-988 criterion 30).
export function actionQueue(pulse: PulseResponse, nowMs: number): ActionRow[] {
  const { work } = pulse;
  const sources: Record<ActionKey, { count: number; records: ActionRecord[] }> = {
    stuckRuns: {
      count: pulse.liveness.stuckRuns.total,
      records: pulse.liveness.stuckRuns.shown.map((r) => ({
        key: r.runId,
        label: r.issueRef ?? "Run",
        detail: r.projectSlug,
        href: r.issueDocId
          ? `/projects/${r.projectSlug}/issues/${r.issueDocId}`
          : `/ops?run=${r.runId}`,
        ageSeconds: r.ageSeconds,
      })),
    },
    abandonedIssues: {
      count: work.abandoned.total,
      records: work.abandoned.shown.map(issueRecord),
    },
    releaseWaiting: {
      count: work.releaseWaiting.total,
      records: work.releaseWaiting.shown.map(issueRecord),
    },
    neverRanProjects: {
      count: work.neverRanProjects.total,
      records: work.neverRanProjects.shown.map((p) => projectRecord(p, nowMs)),
    },
    silentProjects: {
      count: work.silentProjects.total,
      records: work.silentProjects.shown.map((p) => projectRecord(p, nowMs)),
    },
  };

  const rows: ActionRow[] = [];
  for (const key of ACTION_ORDER) {
    const src = sources[key];
    if (src.count === 0) continue;
    rows.push({
      key,
      ...ACTION_META[key],
      count: src.count,
      records: src.records,
      oldestSeconds: src.records.reduce((max, r) => Math.max(max, r.ageSeconds), 0),
    });
  }

  return rows.sort((a, b) => {
    if (a.oldestSeconds !== b.oldestSeconds) return b.oldestSeconds - a.oldestSeconds;
    if (a.count !== b.count) return b.count - a.count;
    return ACTION_ORDER.indexOf(a.key) - ACTION_ORDER.indexOf(b.key);
  });
}

export interface ProjectSilenceRow {
  id: string;
  slug: string;
  name: string;
  buckets: PulseWorkBuckets;
  backlog: number;
  stuckRuns: number;
  abandonedIssues: number;
  lastIssueRunAt: string | null;
  /** null where the project has never started an issue run. */
  silenceSeconds: number | null;
  neverRan: boolean;
}

/**
 * Projects ordered by how long each has gone without an issue run.
 */
// cm:guard a project that has never run sorts ABOVE every silent one and is flagged `neverRan` rather than given a silence figure — "no pipeline has ever run here" and "the last run was 9 days ago" are different facts, and rendering the first as the second is a longer silence the reader cannot act on (ISS-988 criterion 30).
export function projectSilenceRows(pulse: PulseResponse, nowMs: number): ProjectSilenceRow[] {
  return pulse.work.perProject
    .map((p) => {
      const buckets: PulseWorkBuckets = {
        open: p.open,
        inProgress: p.inProgress,
        awaitingRelease: p.awaitingRelease,
        humanBlocked: p.humanBlocked,
      };
      const backlog = p.open + p.inProgress + p.awaitingRelease + p.humanBlocked;
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        buckets,
        backlog,
        stuckRuns: p.stuckRuns,
        abandonedIssues: p.abandonedIssues,
        lastIssueRunAt: p.lastIssueRunAt,
        silenceSeconds: p.lastIssueRunAt
          ? Math.max(0, Math.floor((nowMs - new Date(p.lastIssueRunAt).getTime()) / 1000))
          : null,
        neverRan: p.lastIssueRunAt === null,
      };
    })
    .sort((a, b) => {
      if (a.neverRan !== b.neverRan) return a.neverRan ? -1 : 1;
      return (b.silenceSeconds ?? 0) - (a.silenceSeconds ?? 0);
    });
}

export interface QualityRates {
  finishedTotal: number;
  mergedShare: number;
  reworkRatio: number | null;
  unclassifiedShare: number | null;
  sessionFailureTotal: number;
}

/**
 * The output rates, each over the whole it is a share of.
 */
// cm:guard every rate here is computed from summed COUNTS, never from an average of per-project rates — a mean of means weights a 3-issue project like a 300-issue one, which is exactly the figure this issue removed from the old KPI row (ISS-988 criterion 52).
export function qualityRates(quality: PulseQuality): QualityRates {
  const { finished, rework, sessionFailures } = quality;
  const finishedTotal = finished.merged + finished.closedUnmerged + finished.dropped;
  const sessionFailureTotal = sessionFailures.reduce((n, r) => n + r.count, 0);
  const unclassified =
    sessionFailures.find((r) => r.reason === "unclassified")?.count ?? 0;
  return {
    finishedTotal,
    mergedShare: finishedTotal > 0 ? finished.merged / finishedTotal : 0,
    reworkRatio: rework.code > 0 ? rework.fix / rework.code : null,
    unclassifiedShare:
      sessionFailureTotal > 0 ? unclassified / sessionFailureTotal : null,
    sessionFailureTotal,
  };
}
