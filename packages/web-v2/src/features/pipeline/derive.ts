import { ISSUE_STATUSES } from "@forge/contracts/issue-machine";
import { deriveQueuedStep, hasLiveAgentSession, queuedChipStatus } from "@/features/issues";
import {
  statusToChip,
  statusToTone,
  workStepOf,
} from "@/features/issues";
import { type SemanticTone, type StatusKey, TONE_META } from "@/design/status";
import type { IssueStatus } from "@/features/issues";
import type { StageKey } from "@/design/stages";
import { gateReasonLine } from "@/features/runners";
import { formatElapsed as formatElapsedIn } from "@/lib/i18n/format";
import { productCopy } from "@/lib/i18n/product-copy";
import { labelCopy } from "@/lib/i18n/labels";
import { gateReadingIn } from "@/features/issues";
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
 * A board column's key: one of the statuses. Whether a row is stuck is its standing's (REQ-48 BC-5,
 * the card's note), never a column the board infers from a missing check-in.
 */
type BoardColumnKey = IssueStatus;

/** One column of the board: its key, the word and colour it reads in, and its issues. */
interface BoardColumnGroup {
  key: BoardColumnKey;
  title: string;
  color: string;
  issues: PipelineIssueRow[];
}

/** `in_progress` at step `test` reads "In progress · Test", in the language `label` reads. */
const statusStepIn = (status: IssueStatus, step: string | null, label: ReturnType<typeof labelCopy>): string =>
  status === "in_progress" && step ? `${label("issueStatus", status)} · ${label("workStep", step)}` : label("issueStatus", status);

/** The board's columns: one per status the board's own query CAN RETURN, in the registry's order. */
export function boardColumns(
  excluded: readonly string[] = BOARD_EXCLUDED_STATUSES,
): BoardColumnKey[] {
  const out: BoardColumnKey[] = [];
  for (const status of ISSUE_STATUSES) {
    if (excluded.includes(status)) continue;
    out.push(status);
  }
  return out;
}

/** The colour a column reads in — the same `SemanticTone` its status chip resolves through. */
const columnTone = (key: BoardColumnKey): SemanticTone => statusToTone(key);

/** The column's heading: the status's own word, in `language`. */
const columnTitle = (key: BoardColumnKey, language: string): string => labelCopy(language)("issueStatus", key);

/** The column a board row files under: its status. */
const rowColumn = (issue: PipelineIssueRow): BoardColumnKey => issue.status as IssueStatus;

/** Group issues into the board's columns by the column each row files under. */
export function groupIssuesByColumn(issues: PipelineIssueRow[] | undefined, language = "en"): BoardColumnGroup[] {
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
    title: columnTitle(key, language),
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
  /** Undefined lets `StatusBadge` use the run vocabulary's own label. */
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
    return { verdict: "none", headline: t("sessions.gate.unreportedHead"), detail: t("sessions.gate.unreportedDetail"), reason: null };
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
  language = "en",
): CardStatusView {
  const t = productCopy(language);
  const label = labelCopy(language);
  const queued = deriveQueuedStep(issue.pipelineHealth, hasLiveAgentSession(issue.agentStatus));
  if (queued) {
    const gate = gateReadingIn(queued.gate, t);
    return {
      status: queuedChipStatus(queued),
      label: gate?.short ?? t("pipeline.board.queued"),
      domain: "session",
      waitingReason: gate?.detail ?? "",
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
    label: statusStepIn(status, workStepOf(issue), label),
    domain: "issue",
    waitingReason: "",
    note: "",
  };
}
