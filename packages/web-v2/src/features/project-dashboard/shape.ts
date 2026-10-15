// What the project is doing, said once: quiet, working, degraded, or not yet readable. "Nothing
// needs anyone" is a claim about every read, so a read that is pending, failed or refused makes the
// project unread, never quiet.

import { formatElapsed } from "@/features/overview/derive";
import type { IssueRow } from "@/features/issues/types";
import type { PipelineRunListItem, ThroughputRow } from "@/features/runs/types";
import type { AttentionCut, DashboardAttentionItem, ParkedAge } from "./derive";

/** A question or an attention item that has waited this long on a person makes the project degraded. */
export const OVERDUE_WAIT_SECONDS = 14 * 86_400;

/** A live run with no job on it, silent this long, is stuck rather than between two steps. */
export const STUCK_RUN_SECONDS = 3_600;

const DAY = 86_400;

export type AgeBand = "fresh" | "aging" | "stale" | "overdue";

/** Four bands the chip's weight rises across: under a day, one to three days, three to fourteen, fourteen and over. */
export function ageBand(seconds: number): AgeBand {
  if (seconds < DAY) return "fresh";
  if (seconds < 3 * DAY) return "aging";
  if (seconds < OVERDUE_WAIT_SECONDS) return "stale";
  return "overdue";
}

/** The parked issues' ages by issue id: the open question's wait where there is one, else the last write. */
export function parkedAges(rows: readonly IssueRow[] | undefined): Map<string, ParkedAge> {
  const out = new Map<string, ParkedAge>();
  for (const r of rows ?? []) {
    if (r.waitingOnPersonSince) out.set(r.id, { since: r.waitingOnPersonSince, basis: "entered" });
    else if (r.updatedAt) out.set(r.id, { since: r.updatedAt, basis: "last-write" });
  }
  return out;
}

/** Seconds since an ISO time, or null where it is not a time. */
export function secondsSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 1000));
}

/** A live run holding no job, silent past `STUCK_RUN_SECONDS`: its last session beat, else when it started. */
export function stuckRuns(idle: readonly PipelineRunListItem[], now: number): PipelineRunListItem[] {
  return idle.filter((r) => {
    const quiet = secondsSince(r.lastSessionBeatAt ?? r.startedAt, now);
    return quiet !== null && quiet >= STUCK_RUN_SECONDS;
  });
}

/** One read the page depends on: where it stands, and why when it did not arrive. */
export type ReadState = { read: "pending" } | { read: "failed"; reason: string } | { read: "ok" };

export type ProjectShape = "quiet" | "working" | "degraded" | "unread";

export interface ShapeInput {
  attention: ReadState;
  runs: ReadState;
  sessions: ReadState;
  /** `ok` where the page asks for no parked ages, because the health row lists no parked issue. */
  parked: ReadState;
  items: readonly DashboardAttentionItem[];
  cut: AttentionCut | null;
  slug: string;
  liveSessions: number;
  stuckRuns: readonly PipelineRunListItem[];
  /** Failed jobs the attention response counts for this project, listed or not: the list is capped. */
  failedJobs: number;
  /** Runs parked at the release gate. */
  releaseRuns: number;
  /** Issues in the Awaiting release state, which have no release run at the gate to show for them. */
  releaseIssues: number;
  now: number;
}

export interface BandEntry {
  label: string;
  /** basePath-relative destination. */
  href: string;
}

export interface ProjectReading {
  shape: ProjectShape;
  /** The sentence the screen opens with. */
  headline: string;
  /** Under the headline, where the shape has more to say. */
  detail: string | null;
  /** Degraded only: what is wrong, and the one way in. */
  band: { text: string; entry: BandEntry | null } | null;
  /** Lines for the reads that have not arrived, one each. */
  unread: string[];
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentence(parts: readonly string[]): string {
  const last = parts[parts.length - 1];
  const body = parts.length === 1 ? last : `${parts.slice(0, -1).join(", ")} and ${last}`;
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

/** What a section or the page says of a read that has not arrived: which, and why. Null where it is in. */
export function unreadStatement(subject: string, s: ReadState, isPlural = false): string | null {
  if (s.read === "pending") return `${subject} ${isPlural ? "are" : "is"} still being read.`;
  if (s.read === "failed") return `${subject} could not be read: ${s.reason}`;
  return null;
}

function unreadLines(input: ShapeInput): string[] {
  return [
    unreadStatement("What needs you", input.attention),
    unreadStatement("The project's runs", input.runs, true),
    unreadStatement("The project's live sessions", input.sessions, true),
    unreadStatement("How long parked issues have waited", input.parked),
  ].filter((line): line is string => line !== null);
}

interface Qualifier {
  item: DashboardAttentionItem;
  seconds: number | null;
  kind: "failed" | "overdue";
}

/** The attention items that make a project degraded: a failed job, or a wait measured past the line. */
function qualifiers(input: ShapeInput): Qualifier[] {
  if (input.attention.read !== "ok") return [];
  const out: Qualifier[] = [];
  for (const item of input.items) {
    const seconds = secondsSince(item.since, input.now);
    if (item.actionKind === "retry") {
      out.push({ item, seconds, kind: "failed" });
    } else if (item.sinceBasis === "entered" && seconds !== null && seconds >= OVERDUE_WAIT_SECONDS) {
      out.push({ item, seconds, kind: "overdue" });
    }
  }
  return out;
}

function degradedBand(input: ShapeInput, quals: readonly Qualifier[], stuck: readonly PipelineRunListItem[], failed: number) {
  const overdue = quals.filter((q) => q.kind === "overdue").length;
  const parts: string[] = [];
  if (failed > 0) parts.push(plural(failed, "failed job", "failed jobs"));
  if (stuck.length > 0) parts.push(`${plural(stuck.length, "run", "runs")} stuck, nothing heard for an hour`);
  if (overdue > 0) {
    parts.push(`${plural(overdue, "item", "items")} waiting on a person for over ${OVERDUE_WAIT_SECONDS / DAY} days`);
  }
  const lead =
    failed > 0 && (stuck.length > 0 || overdue > 0)
      ? "Work is blocked and failing"
      : failed > 0
        ? "Work is failing"
        : "Work is blocked";

  const oldest = input.cut ? "oldest listed item" : "oldest item";
  const aged = quals.reduce<(typeof quals)[number] | undefined>(
    (oldest, q) => (q.seconds !== null && (!oldest || q.seconds > (oldest.seconds ?? 0)) ? q : oldest),
    undefined,
  );
  let entry: BandEntry | null = null;
  if (aged && aged.seconds !== null) {
    const how = aged.kind === "failed" ? "failed" : "waiting";
    entry = { label: `Action needed — ${oldest} ${how} ${formatElapsed(aged.seconds)}`, href: aged.item.link };
  } else if (quals[0]) {
    entry = { label: "Action needed — open the first failed job", href: quals[0].item.link };
  } else if (stuck.length > 0 || failed > 0) {
    entry = { label: "Action needed — open the runs", href: `/projects/${input.slug}/agents` };
  }
  return { text: `${lead} — ${parts.join(" · ")}`, entry };
}

/** The one reading of what this project is doing. */
export function projectShape(input: ShapeInput): ProjectReading {
  const quals = qualifiers(input);
  const stuck = input.runs.read === "ok" ? [...input.stuckRuns] : [];
  const unread = unreadLines(input);
  // The list is capped and the count is whole, so a failure is known from the count alone.
  const failed =
    input.attention.read === "ok"
      ? Math.max(input.failedJobs, quals.filter((q) => q.kind === "failed").length)
      : 0;

  // Degraded stands on the reads that did arrive: a failed job is a failed job whether or not the
  // parked ages did.
  if (quals.length > 0 || stuck.length > 0 || failed > 0) {
    const band = degradedBand(input, quals, stuck, failed);
    return { shape: "degraded", headline: band.text, detail: null, band, unread };
  }

  if (unread.length > 0) {
    const failed = [input.attention, input.runs, input.sessions, input.parked].some((s) => s.read === "failed");
    return {
      shape: "unread",
      headline: failed ? "Part of this page could not be read." : "Reading what is going on…",
      detail: null,
      band: null,
      unread,
    };
  }

  const parts: string[] = [];
  if (input.liveSessions > 0) parts.push(`${plural(input.liveSessions, "session is", "sessions are")} live`);
  if (input.items.length > 0 || input.cut) {
    parts.push(
      input.cut
        ? `at least ${plural(input.cut.atLeast, "item needs", "items need")} a person`
        : `${plural(input.items.length, "item needs", "items need")} a person`,
    );
  }
  if (input.releaseRuns > 0) {
    parts.push(`${plural(input.releaseRuns, "run waits", "runs wait")} on a release decision`);
  } else if (input.releaseIssues > 0) {
    parts.push(`${plural(input.releaseIssues, "issue awaits", "issues await")} release`);
  }
  if (parts.length > 0) {
    return { shape: "working", headline: sentence(parts), detail: null, band: null, unread: [] };
  }
  return {
    shape: "quiet",
    headline: "Nothing needs anyone.",
    detail: "No session is live, no run waits on a release, and nothing is waiting on a person.",
    band: null,
    unread: [],
  };
}

/* ------------------------------------------------------------------ *
 * Comparisons: each figure against something the data holds
 * ------------------------------------------------------------------ */

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** Trailing-24h spend against the 7-day daily average; null where the window holds no spend to compare with. */
export function spendComparison(todayUsd: number, weekUsd: number): string | null {
  const normal = weekUsd / 7;
  if (normal <= 0) return null;
  return `${(todayUsd / normal).toFixed(1)}× the 7-day daily average of ${money(normal)}`;
}

/** Shipped on the last UTC day against the average of the six before it; null where the calendar is not seven days. */
export function throughputComparison(days: readonly ThroughputRow[]): string | null {
  if (days.length !== 7) return null;
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const today = ordered[6].count;
  const before = ordered.slice(0, 6).reduce((n, r) => n + r.count, 0) / 6;
  return `${today} today · ${before.toFixed(1)} a day over the six before`;
}

/** The slowest step against the one after it; null where there is one step or the next has no duration. */
export function slowestComparison(
  steps: readonly { step: string; medianSec: number }[],
): { step: string; ratio: number; next: string } | null {
  const [slowest, next] = steps;
  if (!slowest || !next || next.medianSec <= 0) return null;
  return { step: slowest.step, ratio: slowest.medianSec / next.medianSec, next: next.step };
}
