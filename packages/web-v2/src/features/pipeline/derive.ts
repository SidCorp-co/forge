import { ISSUE_STATUSES } from "@forge/contracts/issue-machine";
import { deriveQueuedStep, hasLiveAgentSession, queuedChipStatus } from "@/features/issues/waiting";
import {
  statusLabel,
  statusStepLabel,
  statusToChip,
  statusToTone,
  workStepOf,
} from "@/features/issues/derive";
import { type SemanticTone, STATUS_KEY_TONE, type StatusKey, TONE_META } from "@/design/status";
import type { IssueStatus } from "@/features/issues/types";
import type { StageKey } from "@/design/stages";
import { gateReasonLine } from "@/features/runners/types";
import { formatElapsed } from "@/lib/utils/format";
import { formatElapsed as formatElapsedIn } from "@/lib/i18n/format";
import { copyLocale, productCopy } from "@/lib/i18n/product-copy";
import { BOARD_EXCLUDED_STATUSES, type PipelineIssueRow, type PipelineRunListItem, type PipelineRunStatus, type RunGate } from "./types";

export function jobTypeToStage(jobType: string | null | undefined): StageKey | null {
  switch (jobType) {
    case "triage":
    case "clarify":
    case "plan":
    case "code":
    case "review":
    case "test":
    case "release":
      return jobType;
    case "fix":
      return "code";
    default:
      return null;
  }
}

/**
 * The board drawer header's chip: while the issue's run reading (`runStatusChip`) is `running` or
 * `queued` it shows that; a paused, finished or cancelled run keeps its own status.
 */
export function drawerRunChip(runStatus: PipelineRunStatus, issueRun: StatusKey | null): StatusKey | null {
  if (runStatus === "running" && (issueRun === "running" || issueRun === "queued")) return issueRun;
  return null;
}

/** Format an estimated cost in USD. `$X.XX`, with small-value and zero cases. */
export function formatUsd(usd: number | null | undefined, language = "en"): string {
  if (usd == null) return "—";
  if (usd === 0) return "$0";
  const digits = (n: number) => new Intl.NumberFormat(copyLocale(language), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  if (usd < 0.01) return `<$${digits(0.01)}`;
  return `$${digits(usd)}`;
}

/** Human duration from milliseconds: `820ms` · `4.2s` · `3m 12s` · `1h 04m`. */
export function formatDurationMs(ms: number | null | undefined, language = "en"): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const t = productCopy(language);
  const s = ms / 1000;
  if (s < 60) return t("common.age.seconds", { n: new Intl.NumberFormat(copyLocale(language), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t("common.elapsed.minutes", { m, s: String(Math.floor(s % 60)).padStart(2, "0") });
  const h = Math.floor(m / 60);
  return t("common.elapsed.hours", { h, m: String(m % 60).padStart(2, "0") });
}

/** Human duration from seconds (step-durations view). */
export function formatDurationSec(sec: number | null | undefined, language = "en"): string {
  if (sec == null) return "—";
  return formatDurationMs(sec * 1000, language);
}

/**
 * Index the per-project runs list by `issueId`, keeping the most recent run per
 * issue. The list arrives ordered by `startedAt` desc, so the first run seen
 * for an issue is the latest — later ones are dropped.
 */
export function runsByIssue(
  runs: PipelineRunListItem[] | undefined,
): Map<string, PipelineRunListItem> {
  const map = new Map<string, PipelineRunListItem>();
  for (const run of runs ?? []) {
    if (run.issueId && !map.has(run.issueId)) map.set(run.issueId, run);
  }
  return map;
}

/**
 * A board column's key: one of the statuses, or `unheld` — the `in_progress` rows nothing holds.
 * `in_progress` says a run holds the issue; where nothing has checked in for it the board files the
 * row beside the held ones rather than calling it in progress (ISS-1213).
 */
type BoardColumnKey = IssueStatus | "unheld";

/** One column of the board: its key, the word and colour it reads in, and its issues. */
interface BoardColumnGroup {
  key: BoardColumnKey;
  title: string;
  color: string;
  issues: PipelineIssueRow[];
}

/** How the `unheld` column and card read: its word, and the chip of work nothing is moving. */
const UNHELD_VIEW: { title: string; status: StatusKey } = {
  title: "No check-in",
  status: "paused",
};

/**
 * The board's columns: one per status the board's own query CAN RETURN, in the registry's order,
 * with `unheld` right after `in_progress` while `in_progress` is one of them.
 */
export function boardColumns(
  excluded: readonly string[] = BOARD_EXCLUDED_STATUSES,
): BoardColumnKey[] {
  const out: BoardColumnKey[] = [];
  for (const status of ISSUE_STATUSES) {
    if (excluded.includes(status)) continue;
    out.push(status);
    if (status === "in_progress") out.push("unheld");
  }
  return out;
}

/** The colour a column reads in — the same `SemanticTone` its status chip resolves through. */
function columnTone(key: BoardColumnKey): SemanticTone {
  return key === "unheld" ? STATUS_KEY_TONE[UNHELD_VIEW.status] : statusToTone(key);
}

/** The column's heading: the status's own word, or `No check-in`. */
function columnTitle(key: BoardColumnKey): string {
  return key === "unheld" ? UNHELD_VIEW.title : statusLabel(key);
}

/** The column a board row files under: its status, or `unheld` for an `in_progress` row nothing holds. */
function rowColumn(issue: PipelineIssueRow): BoardColumnKey {
  const status = issue.status as IssueStatus;
  return status === "in_progress" && !issue.held ? "unheld" : status;
}

/** Group issues into the board's columns by the column each row files under. */
export function groupIssuesByColumn(issues: PipelineIssueRow[] | undefined): BoardColumnGroup[] {
  const columns = boardColumns();
  const buckets = new Map<BoardColumnKey, PipelineIssueRow[]>(columns.map((k) => [k, []]));
  for (const issue of issues ?? []) {
    const key = rowColumn(issue);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(issue);
    else buckets.set(key, [issue]);
  }
  return [...buckets.entries()].map(([key, list]) => ({
    key,
    title: columnTitle(key),
    color: TONE_META[columnTone(key)].dot,
    issues: list,
  }));
}

/** Everything a kanban card's status chip needs, from the three signals that
 *  can claim it: a queued step, the issue's live run, and the issue's own
 *  lifecycle status. */
interface CardStatusView {
  status: StatusKey;
  pipelineRun?: PipelineRunStatus;
  /** Undefined lets `StatusChip` use the run vocabulary's own label. */
  label: string | undefined;
  domain: "session" | "issue";
  /** The gate sentence, for the card's tooltip + aria-label; "" when none. */
  waitingReason: string;
  /** A line the card shows under its title; "" when none. */
  note: string;
}

/**
 * What the board can say about a row nothing holds: when anything last spoke for it. Core cannot
 * tell a quiet run from a gone one, so the card gives the time and leaves the gap to the reader.
 */
function checkInLine(lastCheckInAt: string | null, now: number): string {
  if (lastCheckInAt === null) return "No check-in on record";
  const at = new Date(lastCheckInAt);
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `Last check-in ${clock} · ${formatElapsed(now - at.getTime())} ago`;
}

/** ISS-1192 — what a reviewer opening a run session is told about the box's
 *  gate. `none` and `clear` are different facts and never share a picture. */
export interface RunGateNote {
  verdict: "none" | "clear" | "marked" | "failing_open" | "unreadable";
  headline: string;
  detail: string;
  reason: string | null;
}

/** The run could not be fetched: the condition is unknown, which is not "none". */
export function runGateUnfetched(message: string, language = "en"): RunGateNote {
  return {
    verdict: "unreadable",
    headline: productCopy(language)("sessions.gate.unfetched"),
    detail: message,
    reason: null,
  };
}

/** `undefined` is a response that did not carry the field, and says nothing. */
export function runGateNote(gate: RunGate | null | undefined, language = "en"): RunGateNote | null {
  if (gate === undefined) return null;
  const t = productCopy(language);
  if (gate === null) {
    return { verdict: "none", headline: t("sessions.gate.noneHead"), detail: t("sessions.gate.noneDetail"), reason: null };
  }
  if (gate.read === "unreadable") {
    return { verdict: "unreadable", headline: t("sessions.gate.unreadHead"), detail: t("sessions.gate.unreadDetail", { reason: gate.reason }), reason: null };
  }
  const c = gate.condition;
  if (c.verdict === "clear") {
    return { verdict: "clear", headline: t("sessions.gate.clearHead"), detail: t("sessions.gate.clearDetail"), reason: null };
  }
  const rate = c.perDay === null ? t("runners.gate.rateUnstated") : t("runners.gate.perDay", { n: Math.round(c.perDay) });
  const window = c.windowMs === null ? t("runners.span.unknown") : formatElapsedIn(c.windowMs, language);
  return {
    verdict: c.verdict,
    headline: c.verdict === "failing_open" ? t("sessions.gate.failingHead") : t("sessions.gate.markedHead"),
    detail: t("sessions.gate.detail", { count: c.count, rate, window }),
    reason: gateReasonLine(c.byReason, c.count, language),
  };
}

export function cardStatus(
  issue: PipelineIssueRow,
  run: { status: PipelineRunStatus } | undefined,
  now: number = Date.now(),
): CardStatusView {
  // Nothing holds the row, so a run or a queued step the board kept for it is history, not what
  // the card is now: a queued job would have made the row held.
  if (rowColumn(issue) === "unheld") {
    return {
      status: UNHELD_VIEW.status,
      label: UNHELD_VIEW.title,
      domain: "issue",
      waitingReason: "",
      note: checkInLine(issue.lastCheckInAt, now),
    };
  }
  const queued = deriveQueuedStep(issue.pipelineHealth, hasLiveAgentSession(issue.agentStatus));
  if (queued) {
    return {
      status: queuedChipStatus(queued),
      label: queued.gate?.short ?? "Queued",
      domain: "session",
      waitingReason: queued.gate?.detail ?? "",
      note: "",
    };
  }
  if (run) {
    return {
      status: run.status === "running" ? "running" : "paused",
      pipelineRun: run.status,
      label: undefined,
      domain: "session",
      waitingReason: "",
      note: "",
    };
  }
  const status = issue.status as IssueStatus;
  return {
    status: statusToChip(status),
    label: statusStepLabel(status, workStepOf(issue)),
    domain: "issue",
    waitingReason: "",
    note: "",
  };
}
