
import {
  OPEN_WORK_STATES,
  type OpenWorkState,
  WORK_STATE_LABELS,
} from "@forge/contracts/work-state";
import { TONE_META } from "@/design/status";
import type {
  PulseIssueIdentity,
  PulseNotOnLiveIdentity,
  PulseProjectIdentity,
  PulseQuality,
  PulseResponse,
  PulseThresholds,
  PulseWorkBuckets,
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

/** What a queue row or record shows for its age: nothing where it has none to give. */
export function ageText(seconds: number | null): string | null {
  if (seconds === null) return null;
  return seconds === Number.MAX_SAFE_INTEGER ? "never ran" : formatElapsed(seconds);
}

export type SilenceMark = "calm" | "warn" | "alarm";

/**
 * Which of the response's two marks the silence has passed.
 */
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

export const BUCKET_ORDER: readonly OpenWorkState[] = OPEN_WORK_STATES;

const BUCKET_TONE: Record<OpenWorkState, keyof typeof TONE_META> = {
  open: "neutral",
  in_flight: "active",
  awaiting_release: "success",
  blocked_on_person: "attention",
};

/** The issues list on the segment that counted a bucket, so the list's count is the figure's. */
export function bucketHref(slug: string, bucket: OpenWorkState): string {
  return `/projects/${slug}/issues?filter=${bucket}`;
}

export interface WaffleCell {
  key: OpenWorkState;
  label: string;
  count: number;
  color: string;
  destination: Destination;
}

/** The four buckets as waffle categories, workspace-wide. */
export function waffleCells(buckets: PulseWorkBuckets): WaffleCell[] {
  return BUCKET_ORDER.map((key) => ({
    key,
    label: WORK_STATE_LABELS[key],
    count: buckets[key],
    color: TONE_META[BUCKET_TONE[key]].dot,
    destination: { kind: "anchor", anchorId: "pulse-per-project" } as const,
  }));
}

export type ActionKey =
  | "stuckRuns"
  | "abandonedIssues"
  | "releaseWaiting"
  | "notOnLive"
  | "liveUnmeasured"
  | "neverRanProjects"
  | "silentProjects";

export type ActionOwner = "person" | "machine";

/**
 * The tie-break of last resort, so one response renders in one order.
 */
export const ACTION_ORDER: ActionKey[] = [
  "stuckRuns",
  "abandonedIssues",
  "releaseWaiting",
  "notOnLive",
  "liveUnmeasured",
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
  notOnLive: {
    label: "Closed, not on production",
    owner: "person",
    hint: "Closed on a promotion that has not happened: a commit of each is on the base branch and not the live one.",
  },
  liveUnmeasured: {
    label: "Promote projects Forge could not fully compare",
    owner: "person",
    hint: "Forge cannot tell whether closed issues here reached the live branch: the comparison failed, was cut short, or was taken before they merged.",
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
  /** Null where the record has no age: a refused comparison says when it was read, not since when. */
  ageSeconds: number | null;
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
  /** Null where no record under the row has an age. */
  oldestSeconds: number | null;
}

const issueRecord = (i: PulseIssueIdentity): ActionRecord => ({
  key: i.documentId,
  label: i.issueRef,
  detail: i.title,
  href: `/projects/${i.projectSlug}/issues/${i.documentId}`,
  ageSeconds: i.ageSeconds,
});

const notOnLiveRecord = (i: PulseNotOnLiveIdentity): ActionRecord => {
  const first = i.evidence[0];
  return {
    ...issueRecord(i),
    detail: first ? `${i.title} · ${first.sha.slice(0, 8)} not on ${i.liveBranch}` : i.title,
  };
};

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
    notOnLive: {
      count: work.notOnLive.total,
      records: work.notOnLive.shown.map(notOnLiveRecord),
    },
    liveUnmeasured: {
      count: work.liveUnmeasured.total,
      records: work.liveUnmeasured.shown.map((p) => ({
        key: p.id,
        label: p.name,
        detail: p.reason,
        href: `/projects/${p.slug}`,
        ageSeconds: null,
      })),
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
      oldestSeconds: src.records.reduce<number | null>(
        (max, r) => (r.ageSeconds === null ? max : Math.max(max ?? 0, r.ageSeconds)),
        null,
      ),
    });
  }

  return rows.sort((a, b) => {
    const ageA = a.oldestSeconds ?? -1;
    const ageB = b.oldestSeconds ?? -1;
    if (ageA !== ageB) return ageB - ageA;
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
export function projectSilenceRows(pulse: PulseResponse, nowMs: number): ProjectSilenceRow[] {
  return pulse.work.perProject
    .map((p) => {
      const buckets: PulseWorkBuckets = {
        open: p.open,
        in_flight: p.in_flight,
        awaiting_release: p.awaiting_release,
        blocked_on_person: p.blocked_on_person,
      };
      const backlog = OPEN_WORK_STATES.reduce((n, state) => n + buckets[state], 0);
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
