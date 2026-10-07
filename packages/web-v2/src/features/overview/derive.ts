
import type { PulseActionKey } from "@forge/contracts/needs-you";
import { TONE_META } from "@/design/status";
import type { Copy } from "@/lib/i18n/product-copy";
import {
  PULSE_BUCKET_STATUSES,
  type PulseQuality,
  type PulseResponse,
  type PulseThresholds,
  type PulseWorkBuckets,
} from "./types";

/** Elapsed seconds as one calm phrase, in the interface language. */
export function formatElapsed(seconds: number | null, t: Copy): string {
  if (seconds === null) return t("overview.never");
  if (seconds < 60) return t("common.age.seconds", { n: seconds });
  const m = Math.floor(seconds / 60);
  if (m < 60) return t("common.age.minutes", { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t("common.age.hours", { n: h });
  return t("common.age.days", { n: Math.floor(h / 24) });
}

/** What a queue row or record shows for its age: nothing where it has none to give. */
export function ageText(seconds: number | null, t: Copy): string | null {
  if (seconds === null) return null;
  return seconds === Number.MAX_SAFE_INTEGER ? t("overview.neverRan") : formatElapsed(seconds, t);
}

/** A record's detail as core words it (`me/pulse-actions.ts`), in the interface language; a title or a slug reads as written. */
export function recordDetail(detail: string, t: Copy): string {
  const waiting = /^(\d+) issues? waiting$/.exec(detail);
  if (waiting) return waiting[1] === "1" ? t("overview.record.waitingOne") : t("overview.record.waiting", { n: Number(waiting[1]) });
  const notOnLive = /^(.+) · ([0-9a-f]{8}) not on (\S+)$/.exec(detail);
  if (notOnLive) return t("overview.record.notOnLive", { title: notOnLive[1] ?? "", sha: notOnLive[2] ?? "", branch: notOnLive[3] ?? "" });
  return detail;
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

export type PanelKey = "liveJobs" | PulseActionKey;

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
export function waffleCells(buckets: PulseWorkBuckets, t: Copy): WaffleCell[] {
  return BUCKET_ORDER.map((key) => ({
    key,
    label: t(`overview.bucket.${key}`),
    count: buckets[key],
    color: TONE_META[BUCKET_TONE[key]].dot,
    destination: { kind: "anchor", anchorId: "pulse-per-project" } as const,
  }));
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
