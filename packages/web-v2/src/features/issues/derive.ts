// web-v2 feature module: issues — PURE derivations (unit-tested in
// `derive.test.ts`). No React, no IO: status → stage / chip / run, dependency
// counts, filter → server params, client grouping, comment-kind heuristic.

import { STAGES, STAGE_INDEX, type StageKey } from "@/design/stages";
import { STATUS_KEY_TONE, type SemanticTone, type StatusKey } from "@/design/status";
import { ISSUE_STATUSES } from "./types";
import type {
  CommentKind,
  GroupBy,
  IssueAgentSession,
  IssueAgentStatus,
  IssueComplexity,
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssueFilter,
  IssuePriority,
  IssueRow,
  IssueStatus,
  PipelineHealth,
  StepDurationRow,
  StepHandoffRow,
  WaitingReason,
} from "./types";

/**
 * Human-readable labels for the lifecycle enums. Single source of truth so the
 * table, rail, and detail header all show the same professional text instead of
 * the raw wire values (`in_progress`, `xs`, …). Keys stay in lockstep with the
 * `IssueStatus`/`IssuePriority`/`IssueComplexity` unions in `types.ts`; the
 * helpers fall back to the raw value if a key is ever missing (drift guard).
 */
export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: "Open",
  confirmed: "Confirmed",
  clarified: "Clarified",
  waiting: "Waiting",
  approved: "Approved",
  in_progress: "In progress",
  developed: "Developed",
  deploying: "Deploying",
  testing: "Testing",
  tested: "Tested",
  released: "Released",
  closed: "Closed",
  reopen: "Reopened",
  on_hold: "On hold",
  needs_info: "Needs info",
  draft: "Draft",
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "None",
};

export const COMPLEXITY_LABELS: Record<IssueComplexity, string> = {
  xs: "XS",
  s: "Small",
  m: "Medium",
  l: "Large",
  xl: "XL",
};

export const statusLabel = (s: IssueStatus): string => STATUS_LABELS[s] ?? s;
export const priorityLabel = (p: IssuePriority): string => PRIORITY_LABELS[p] ?? p;
export const complexityLabel = (c: IssueComplexity | null | undefined): string =>
  c ? (COMPLEXITY_LABELS[c] ?? c) : "—";

/**
 * Map a core issue status to a pipeline stage so the per-row mini tracker
 * reflects where the issue sits. Ported from the project overview page's
 * `STATUS_TO_STAGE` (`(workspace)/projects/[slug]/page.tsx`).
 */
export const STATUS_TO_STAGE: Record<IssueStatus, StageKey> = {
  open: "triage",
  needs_info: "triage",
  confirmed: "clarify",
  clarified: "plan",
  draft: "triage",
  waiting: "plan",
  approved: "plan",
  in_progress: "code",
  reopen: "code",
  developed: "review",
  deploying: "test",
  testing: "test",
  tested: "test",
  released: "release",
  closed: "release",
  on_hold: "code",
};

export function statusToStage(status: IssueStatus): StageKey {
  return STATUS_TO_STAGE[status] ?? "triage";
}

type RunStatus = "running" | "done" | "failed" | "blocked" | "queued" | "review";

/**
 * Run-status for the mini PipelineTracker. Prefer the live agent status (the
 * search endpoint hydrates `agentStatus` with `withAgentSessions=1`); when no
 * agent is active fall back to a status-derived bead state.
 */
export function statusToRun(status: IssueStatus, agentStatus?: IssueAgentStatus): RunStatus {
  if (agentStatus === "running") return "running";
  if (agentStatus === "queued") return "queued";
  if (agentStatus === "failed") return "failed";
  switch (status) {
    case "released":
    case "closed":
      return "done";
    case "developed":
      return "review";
    case "on_hold":
      return "blocked";
    case "in_progress":
    case "reopen":
      return "running";
    default:
      return "queued";
  }
}

/**
 * Map an issue lifecycle status (+ optional live agent status) to a design-kit
 * `StatusKey` for the StatusChip. A running/queued agent wins so the chip shows
 * the live `running · <stage>` band.
 */
export function statusToChip(status: IssueStatus, agentStatus?: IssueAgentStatus): StatusKey {
  if (agentStatus === "running") return "running";
  if (agentStatus === "queued") return "queued";
  if (agentStatus === "failed") return "failed";
  switch (status) {
    case "in_progress":
    case "reopen":
      return "running";
    case "open":
    case "confirmed":
    case "clarified":
    case "approved":
    case "draft":
      return "queued";
    case "waiting":
    case "needs_info":
      return "waiting";
    case "developed":
    case "deploying":
    case "testing":
      return "review";
    case "tested":
      return "passed";
    case "released":
      return "shipped"; // ISS-511 — distinct flame, "shipped to prod"
    case "closed":
      return "archived"; // ISS-511 — heavy ink, "filed away"
    case "on_hold":
      return "paused";
    default:
      return "queued";
  }
}

/**
 * Map an issue lifecycle status to a semantic TONE (ISS-509). Defined as
 * `tone(statusToChip(status))` — the base chip mapping, no live-agent override —
 * so a status's tone is IDENTICAL in its chip and in every dashboard bucket that
 * folds it (the overview work-distribution bar + the project-dashboard donut
 * both color through this). Total over all 16 `IssueStatus`es, and NO benign /
 * blocked / idle status resolves to the `failure` tone (guarded in
 * `derive.test.ts`).
 */
export function statusToTone(status: IssueStatus): SemanticTone {
  return STATUS_KEY_TONE[statusToChip(status)];
}

/**
 * Status targets the server will accept from `from`, for the inline status
 * editors. Mirrors core's runtime guard `canTransitionFree`
 * (`pipeline/state-machine.ts`): the lifecycle is permissive — any state may
 * branch to needs_info / on_hold / reopen / forward — the ONLY hard rules are
 * (1) `draft` is never a transition target and (2) a `draft` may only be
 * promoted to `open`, handed off direct-ship to `developed` (ISS-431 — work
 * done outside the pipeline enters at the review gate), or discarded to
 * `closed`. Filtering to this set stops the menu from offering picks that 409
 * and silently snap back (ISS-308 E1).
 */
export function allowedTransitions(from: IssueStatus): IssueStatus[] {
  if (from === "draft") return ["open", "developed", "closed"];
  return ISSUE_STATUSES.filter((s) => s !== from && s !== "draft");
}

/**
 * Status targets valid for a BULK action — the intersection of
 * `allowedTransitions()` across every selected row, preserving enum order. Only
 * offering common-valid targets means a bulk pick can't mass-409 (mirrors the
 * per-row ISS-308 E1 guard). Empty selection, or rows with no common target,
 * → `[]` (the bulk bar then disables the Set-status control). ISS-463.
 */
export function bulkAllowedStatuses(rows: IssueRow[]): IssueStatus[] {
  if (rows.length === 0) return [];
  let common: IssueStatus[] | null = null;
  for (const r of rows) {
    const allowed = allowedTransitions(r.status);
    if (common === null) {
      common = allowed;
    } else {
      const allowedSet = new Set(allowed);
      common = common.filter((s) => allowedSet.has(s));
    }
  }
  return common ?? [];
}

export interface DepCounts {
  blockedBy: number;
  blocks: number;
  /** Outgoing `decomposes` edges — this issue is an epic with N subtasks. */
  subtasks: number;
  /** Any incoming `decomposes` edge — this issue is a subtask of an epic. */
  hasParent: boolean;
}

/**
 * Dependency badge counts for an issue. Edge `kind` encodes "from <verb> to":
 * - `blocks`: for issue `id` it is BLOCKED-BY each incoming `blocks` edge and
 *   BLOCKS each outgoing one.
 * - `decomposes` (system-owned, core `decompose.ts`): the edge runs
 *   parent→child, so an OUTGOING `decomposes` means `id` is the epic and the
 *   other endpoint a subtask; an INCOMING one means `id` is a subtask of a
 *   parent epic. (Legacy `parent` kind is treated the same, defensively.)
 */
export function depCounts(deps: IssueDependencies | undefined): DepCounts {
  if (!deps) return { blockedBy: 0, blocks: 0, subtasks: 0, hasParent: false };
  const blockedBy = deps.incoming.filter((e) => e.kind === "blocks").length;
  const blocks = deps.outgoing.filter((e) => e.kind === "blocks").length;
  const isParentEdge = (k: IssueDependencyEdge["kind"]) => k === "decomposes" || k === "parent";
  const subtasks = deps.outgoing.filter((e) => isParentEdge(e.kind)).length;
  const hasParent = deps.incoming.some((e) => isParentEdge(e.kind));
  return { blockedBy, blocks, subtasks, hasParent };
}

/**
 * Translate a filter tab into server `status`/`statusNot` arrays.
 * - all: literally EVERY issue, INCLUDING drafts + closed/released — no filter
 *   at all (the search endpoint applies no default draft exclusion, verified
 *   core/issues/search.ts). ISS-360: "all issues" means all issues, drafts
 *   included; this intentionally reverses the ISS-236 "All excludes drafts"
 *   rule and removes the separate Drafts tab the reporter flagged as confusing.
 * - draft: only drafts (ISS-438 — there was no way to see just drafts)
 * - active: the in-flight lifecycle band
 * - review: developed/deploying/testing/tested
 * - blocked: on_hold + needs_info (work parked / waiting on input)
 * - done: shipped work (released + closed)
 */
export function filterToStatusParams(filter: IssueFilter): {
  status?: IssueStatus[];
  statusNot?: IssueStatus[];
} {
  switch (filter) {
    case "draft":
      return { status: ["draft"] };
    case "active":
      return { status: ["open", "confirmed", "clarified", "waiting", "approved", "in_progress", "reopen"] };
    case "review":
      return { status: ["developed", "deploying", "testing", "tested"] };
    case "blocked":
      return { status: ["on_hold", "needs_info"] };
    case "done":
      return { status: ["released", "closed"] };
    default:
      return {};
  }
}

export interface IssueGroup {
  key: string;
  label: string;
  rows: IssueRow[];
}

/** Resolve a member display label (email local-part) for grouping/avatars. */
export function memberLabel(
  assigneeId: string | null,
  members?: { userId: string; email: string }[],
): string {
  if (!assigneeId) return "Unassigned";
  const m = members?.find((x) => x.userId === assigneeId);
  return m ? m.email : assigneeId.slice(0, 8);
}

/** Two-letter initials from an email/id, for the assignee Avatar. */
export function initials(label: string): string {
  const at = label.indexOf("@");
  const base = at > 0 ? label.slice(0, at) : label;
  const parts = base.split(/[.\-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

/**
 * Group rows client-side. `none` returns a single group. Within each group the
 * server-provided order is preserved (server already sorted). Group ordering is
 * deterministic (by the natural enum/status order, Unassigned last for people).
 */
export function groupRows(
  rows: IssueRow[],
  groupBy: GroupBy,
  members?: { userId: string; email: string }[],
): IssueGroup[] {
  if (groupBy === "none") {
    return [{ key: "all", label: "All issues", rows }];
  }
  const buckets = new Map<string, IssueRow[]>();
  for (const r of rows) {
    let key: string;
    if (groupBy === "status") key = r.status;
    else if (groupBy === "priority") key = r.priority;
    else key = r.assigneeId ?? "__unassigned__";
    const arr = buckets.get(key);
    if (arr) arr.push(r);
    else buckets.set(key, [r]);
  }
  const groups: IssueGroup[] = [];
  for (const [key, groupRowsArr] of buckets) {
    let label = key;
    if (groupBy === "assignee") {
      label = key === "__unassigned__" ? "Unassigned" : memberLabel(key, members);
    }
    groups.push({ key, label, rows: groupRowsArr });
  }
  // Stable order: people groups push Unassigned last; status/priority keep map
  // insertion order (which follows the server sort).
  if (groupBy === "assignee") {
    groups.sort((a, b) => {
      if (a.key === "__unassigned__") return 1;
      if (b.key === "__unassigned__") return -1;
      return a.label.localeCompare(b.label);
    });
  }
  return groups;
}

/**
 * Heuristic lifecycle-kind for a comment. The pipeline writes comments in fixed
 * formats but there is no server `kind` column, so match the body. Order
 * matters — more specific markers first. Falls back to a plain comment.
 */
export function deriveCommentKind(body: string): CommentKind {
  const b = body.toLowerCase();
  if (/^#+\s*triage|triage (report|summary)|\btriaged\b/.test(b)) return "triage";
  if (/request changes|requesting changes|changes requested/.test(b)) return "changes";
  if (/\bapprove\b|approved ✅|review: approve|verdict: approve/.test(b)) return "approved";
  if (/forge-fix|^#+\s*fix\b|fix applied/.test(b)) return "fix";
  if (/qa test report|qa report|test report|e2e (pass|report)|verified live/.test(b)) return "qa";
  if (/released|release note|published release|shipped/.test(b)) return "released";
  if (/forge-code|plan implemented|implementation complete|code complete|pushed .* branch/.test(b))
    return "code";
  if (/plan written|^#+\s*(implementation )?plan\b|approved plan/.test(b)) return "plan";
  if (/^#+\s*clarif|clarif(y|ication)/.test(b)) return "clarify";
  if (/^#+\s*review\b|reviewing|self-review/.test(b)) return "review";
  return "comment";
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
}

/**
 * Parse an acceptance-criteria blob into checklist items. Recognises markdown
 * task syntax (`- [ ]` / `- [x]`), plain bullets (`-`/`*`), and bare lines.
 * Blank lines + pure markdown headings are dropped. Prefer the structured
 * `aiAcceptanceCriteria[]` when the caller has it; this is the text fallback.
 */
export function parseChecklist(text: string | null | undefined): ChecklistItem[] {
  if (!text) return [];
  const items: ChecklistItem[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // skip headings
    const task = line.match(/^[-*]\s*\[( |x|X)\]\s*(.+)$/);
    if (task) {
      items.push({ text: task[2].trim(), checked: task[1].toLowerCase() === "x" });
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      items.push({ text: bullet[1].trim(), checked: false });
      continue;
    }
    items.push({ text: line, checked: false });
  }
  return items;
}

// ─── ISS-377: blocker banner · live-agent heartbeat · per-stage outcomes ─────

/** Heartbeat staleness threshold. Mirrors core's sweeper
 *  `HEARTBEAT_TIMEOUT_MS_DEFAULT = 3*60_000` (`pipeline/sweeper.ts`, env
 *  `PIPELINE_HEARTBEAT_TIMEOUT_MS`). Not env-readable from the FE, so kept in
 *  lockstep here; a session whose last heartbeat is older than this is the same
 *  "stale" the server uses before marking it failed. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export type HeartbeatState = "alive" | "stale" | "unknown";

/** Alive vs stale from a session's `lastHeartbeatAt` (AC#3). `unknown` when the
 *  field is absent (older server) or unparseable — the caller then hides the
 *  dot rather than lying about liveness. `nowMs` is injectable for tests. */
export function heartbeatState(
  lastHeartbeatAt: string | null | undefined,
  nowMs: number = Date.now(),
): HeartbeatState {
  if (!lastHeartbeatAt) return "unknown";
  const t = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(t)) return "unknown";
  return nowMs - t <= HEARTBEAT_STALE_MS ? "alive" : "stale";
}

export type BlockerCtaKind = "approve" | "provide-info" | "resume" | "open-blocker" | "none";

/** A blocking dependency endpoint, ready to render as a clickable ISS-x chip. */
export interface BlockingRef {
  id: string;
  displayId: string;
  title: string | null;
  status: IssueStatus | null;
}

/** Single server-derived "why is it stuck" verdict for the blocker banner
 *  (AC#1/#2). Computed in ONE place from status / pipelineHealth.waitingOn /
 *  blocks edges — the component never re-joins those sources. `null` ⇒ not
 *  blocked ⇒ render nothing. */
export interface BlockerState {
  tone: "danger" | "attention" | "info";
  reason: string;
  whoMustAct: string;
  cta: { label: string; kind: BlockerCtaKind };
  /** The actual question to answer, for `needs_info`. */
  question?: string;
  /** Open `blocks` issues this one is waiting on. */
  blockingRefs?: BlockingRef[];
  /** Extra context (failure classification, hold-until), Tier-2 detail. */
  detail?: string;
}

const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set(["released", "closed"]);

/** Incoming `blocks` edges whose blocker isn't terminal — i.e. this issue is
 *  genuinely blocked-by an open issue. */
function openBlockingRefs(deps: IssueDependencies | undefined): BlockingRef[] {
  if (!deps) return [];
  return deps.incoming
    .filter((e) => e.kind === "blocks" && !(e.fromStatus && TERMINAL_STATUSES.has(e.fromStatus)))
    .map((e) => ({
      id: e.fromIssueId,
      displayId: e.fromDisplayId ?? `ISS-${e.fromIssueId.slice(0, 6)}`,
      title: e.fromTitle ?? null,
      status: e.fromStatus ?? null,
    }));
}

const WAITING_REASON_COPY: Record<WaitingReason, { reason: string; who: string }> = {
  issue_busy: { reason: "Another job is already active on this issue.", who: "Wait for the active run to finish." },
  waiting_on_dep: { reason: "Blocked by an unfinished dependency.", who: "Finish the blocking issue first." },
  waiting_on_decomp_parent: { reason: "Waiting on its parent epic to finish releasing.", who: "The parent epic must complete." },
  project_full: { reason: "The project's concurrency cap is reached.", who: "No action — dispatches when a slot frees." },
  runner_full: { reason: "The pinned runner is at capacity.", who: "No action — dispatches when the runner frees." },
};

/**
 * Derive the single blocker verdict for an issue, or `null` when it is actively
 * progressing. Precedence (richest signal first): needs_info →
 * waiting-for-approve → on_hold → pipelineHealth capacity/dep waits → open
 * `blocks` edges. `needsInfoQuestion` is supplied by the screen (which can read
 * the latest comment); kept as an arg so this stays pure + unit-testable.
 *
 * ISS-393 removed the manual-hold failure card: a mechanically-failed job now
 * reverts the issue to its stage entry-status (auto re-dispatch) or parks it at
 * `waiting` for human review — both already covered by the branches below.
 */
export function deriveBlockerState(
  issue: Pick<IssueDetail, "status">,
  pipelineHealth: PipelineHealth | undefined,
  deps: IssueDependencies | undefined,
  opts: { needsInfoQuestion?: string } = {},
): BlockerState | null {
  const blockingRefs = openBlockingRefs(deps);

  // 1. needs_info — a human owes an answer.
  if (issue.status === "needs_info") {
    return {
      tone: "attention",
      reason: "The pipeline needs more information before it can continue.",
      whoMustAct: "The reporter (or a maintainer) must answer and re-open.",
      cta: { label: "Provide info", kind: "provide-info" },
      question: opts.needsInfoQuestion?.trim() || undefined,
      ...(blockingRefs.length ? { blockingRefs } : {}),
    };
  }

  // 3. waiting — a plan is awaiting human approval before coding.
  if (issue.status === "waiting") {
    return {
      tone: "attention",
      reason: "The plan is written and awaiting human approval before coding starts.",
      whoMustAct: "A maintainer must approve (or reopen) the issue.",
      cta: { label: "Approve", kind: "approve" },
      ...(blockingRefs.length ? { blockingRefs } : {}),
    };
  }

  // 4. on_hold status — deliberately paused via the state machine.
  if (issue.status === "on_hold") {
    return {
      tone: "attention",
      reason: "The issue is paused.",
      whoMustAct: "An operator must resume it.",
      cta: { label: "Resume", kind: "resume" },
      ...(blockingRefs.length ? { blockingRefs } : {}),
    };
  }

  // 5. pipelineHealth capacity / dependency waits.
  const waitingOn = pipelineHealth?.waitingOn;
  if (waitingOn && WAITING_REASON_COPY[waitingOn.reason]) {
    const copy = WAITING_REASON_COPY[waitingOn.reason];
    const isDep = waitingOn.reason === "waiting_on_dep" || waitingOn.reason === "waiting_on_decomp_parent";
    return {
      tone: "info",
      reason: copy.reason,
      whoMustAct: copy.who,
      cta:
        isDep && blockingRefs.length
          ? { label: "Open blocking issue", kind: "open-blocker" }
          : { label: "", kind: "none" },
      ...(blockingRefs.length ? { blockingRefs } : {}),
    };
  }

  // 6. Open `blocks` edge with no health signal — still blocked-by an open issue.
  if (blockingRefs.length) {
    return {
      tone: "info",
      reason: `Blocked by ${blockingRefs.length} open issue${blockingRefs.length > 1 ? "s" : ""}.`,
      whoMustAct: "Finish the blocking issue(s) first.",
      cta: { label: "Open blocking issue", kind: "open-blocker" },
      blockingRefs,
    };
  }

  return null;
}

/** Pipeline step name (job type) → one of the 7 design stages. `fix` folds into
 *  `code`; `pm`/`custom` have no stage and are dropped. */
const STEP_TO_STAGE: Record<string, StageKey> = {
  triage: "triage",
  clarify: "clarify",
  plan: "plan",
  code: "code",
  fix: "code",
  review: "review",
  test: "test",
  release: "release",
};

export function stepToStage(step: string): StageKey | null {
  return STEP_TO_STAGE[step] ?? null;
}

export type StageCellState = "done" | "current" | "pending" | "error";

/** One stage's rolled-up view for the tracker spine + artifact card (AC#4/#5). */
export interface StageCell {
  state: StageCellState;
  outcomeLabel?: string;
  durationSeconds?: number;
  costUsd?: number;
  handoff?: StepHandoffRow;
}

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Pull a short, human one-liner from a free-form handoff payload. Tries the
 *  stable fields first, then any string field; never throws on a missing/odd
 *  shape (AC#4 graceful fallback). */
export function handoffOutcomeLabel(payload: Record<string, unknown> | null | undefined): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const preferred = ["outcome", "summary", "verdict", "result", "planSummary", "rootCauseHypothesis"];
  for (const k of preferred) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return truncate(v, 90);
  }
  for (const v of Object.values(payload)) {
    if (typeof v === "string" && v.trim()) return truncate(v, 90);
  }
  return undefined;
}

/**
 * Build the per-stage cells for all 7 stages. Stage state derives from the
 * SINGLE `statusToStage` projection (passed in as `currentStage`) — no second
 * mapping (AC#5). Durations/cost are summed across attempts of that stage from
 * the step-durations rows (AC#6); the latest-attempt handoff is attached.
 */
export function deriveStageOutcomes(
  currentStage: StageKey,
  runStatus: "running" | "done" | "failed" | "blocked" | "queued" | "review",
  handoffs: StepHandoffRow[] | undefined,
  durations: StepDurationRow[] | undefined,
  failureStep?: string | null,
): Record<StageKey, StageCell> {
  const currentIdx = STAGE_INDEX[currentStage] ?? 0;
  const allDone = runStatus === "done";
  const failureStage = failureStep ? stepToStage(failureStep) : null;

  // Latest-attempt handoff per stage.
  const handoffByStage = new Map<StageKey, StepHandoffRow>();
  for (const row of handoffs ?? []) {
    const stage = stepToStage(row.step);
    if (!stage) continue;
    const prev = handoffByStage.get(stage);
    if (!prev || row.attempt > prev.attempt) handoffByStage.set(stage, row);
  }

  // Duration + cost per stage, scoped to the MOST-RECENT run for that stage so a
  // reopened issue (multiple runs of the same step) doesn't double-count. Within
  // the chosen run, sum across attempts. ISS-377 review fix.
  const byStageRun = new Map<StageKey, Map<string, { durationSeconds: number; costUsd: number; latest: string }>>();
  for (const row of durations ?? []) {
    const stage = stepToStage(row.step);
    if (!stage) continue;
    const runs = byStageRun.get(stage) ?? new Map();
    const acc = runs.get(row.runId) ?? { durationSeconds: 0, costUsd: 0, latest: "" };
    acc.durationSeconds += row.durationSeconds ?? 0;
    acc.costUsd += row.costUsd ?? 0;
    if ((row.finishedAt ?? row.startedAt ?? "") > acc.latest) acc.latest = row.finishedAt ?? row.startedAt ?? "";
    runs.set(row.runId, acc);
    byStageRun.set(stage, runs);
  }
  const durByStage = new Map<StageKey, { durationSeconds: number; costUsd: number }>();
  for (const [stage, runs] of byStageRun) {
    let pick: { durationSeconds: number; costUsd: number; latest: string } | undefined;
    for (const acc of runs.values()) {
      if (!pick || acc.latest > pick.latest) pick = acc;
    }
    if (pick) durByStage.set(stage, { durationSeconds: pick.durationSeconds, costUsd: pick.costUsd });
  }

  const cells = {} as Record<StageKey, StageCell>;
  for (const { key } of STAGES) {
    const i = STAGE_INDEX[key];
    let state: StageCellState;
    if (failureStage === key && (runStatus === "failed" || runStatus === "blocked")) {
      state = "error";
    } else if (allDone) {
      state = "done";
    } else if (i < currentIdx) {
      state = "done";
    } else if (i === currentIdx) {
      state = runStatus === "failed" || runStatus === "blocked" ? "error" : "current";
    } else {
      state = "pending";
    }
    const handoff = handoffByStage.get(key);
    const dur = durByStage.get(key);
    cells[key] = {
      state,
      ...(handoff ? { handoff, outcomeLabel: handoffOutcomeLabel(handoff.payload) } : {}),
      ...(dur && dur.durationSeconds > 0 ? { durationSeconds: dur.durationSeconds } : {}),
      ...(dur && dur.costUsd > 0 ? { costUsd: dur.costUsd } : {}),
    };
  }
  return cells;
}

// ─── ISS-376: session-group continuity (resumed / fresh) ────────────────────

/** Known session-group keys → humanized labels. The label set is data-driven:
 *  any unknown key (a project may define its own groups) gets a Title-Case
 *  fallback so the raw `sessionGroup` value never reaches the UI (AC8). */
const SESSION_GROUP_LABELS: Record<string, string> = {
  build: "Build",
  planning: "Planning",
  verify: "Verify",
};

/** Title-case a raw group key as a fallback (`new-group` → "New Group"). */
function titleCase(key: string): string {
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function humanizeSessionGroup(key: string | null | undefined): string {
  if (!key) return "Session";
  return SESSION_GROUP_LABELS[key] ?? titleCase(key);
}

/** Whether a step reused the prior same-group Claude session, started a new one,
 *  or carries too little metadata to tell (legacy rows → no badge). */
export type SessionContinuity = "resumed" | "fresh" | "unknown";

/** Why a step is `fresh` rather than `resumed` — surfaced in operator detail. */
export type FreshReason =
  | "first-in-group"
  | "different-device"
  | "prior-failed"
  | "new-session";

/** One row of the session-continuity timeline — a pure projection of an
 *  `IssueAgentSession`. Holds both the humanized labels (default view) and the
 *  short raw ids (operator expand); the component decides what to show. */
export interface SessionTimelineEntry {
  id: string;
  /** Pipeline step label (`metadata.jobType`), e.g. `plan` / `review`. */
  jobType: string | null;
  /** Raw group key (`metadata.sessionGroup`) — for keys, never rendered. */
  group: string | null;
  /** Humanized group label (`Build` / `Verify` / …). */
  groupLabel: string | null;
  claudeSessionId: string | null;
  claudeShort: string | null;
  deviceId: string | null;
  deviceShort: string | null;
  /** ISS-411 — friendly runner name (`devices.name`); null on a pre-411 server
   *  or when the device row is gone. The UI prefers this over `deviceShort`. */
  deviceName: string | null;
  status: string;
  startedAt: string | null;
  continuity: SessionContinuity;
  /** Set only when `continuity === 'fresh'`. */
  freshReason: FreshReason | null;
  /** True when this entry shares a Claude session with the entry directly above
   *  it (drives the solid connector); false at a `fresh session` break. */
  connectedToPrev: boolean;
}

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.trim() ? v : null;
}

/** Best chronological timestamp for ordering. The hydrator returns sessions
 *  `updatedAt desc`; we sort ascending by the earliest available start time. */
function startMs(s: IssueAgentSession): number {
  const iso = s.startedAt ?? s.createdAt ?? s.updatedAt;
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Derive the session-continuity timeline (AC6/7/8/9). Pure FE over
 * `issue.agentSessions`: walks sessions chronologically, comparing each
 * session's `claudeSessionId` to the prior session in the SAME group to mark it
 * `resumed` (same id) or `fresh` (different / first). Rows missing `group` or
 * `claudeSessionId` degrade to `unknown` (rendered without a badge) so older
 * sessions never throw.
 */
export function deriveSessionTimeline(
  sessions: IssueAgentSession[] | null | undefined,
): SessionTimelineEntry[] {
  if (!sessions || sessions.length === 0) return [];
  const ordered = [...sessions].sort((a, b) => startMs(a) - startMs(b));

  const lastByGroup = new Map<string, { claude: string; deviceId: string | null; status: string }>();
  let prevClaude: string | null = null;
  const entries: SessionTimelineEntry[] = [];

  for (const s of ordered) {
    const group = metaString(s.metadata, "sessionGroup");
    const jobType = metaString(s.metadata, "jobType");
    const claude = s.claudeSessionId ?? null;
    const deviceId = s.deviceId ?? null;

    let continuity: SessionContinuity;
    let freshReason: FreshReason | null = null;

    if (!group || !claude) {
      continuity = "unknown";
    } else {
      const prior = lastByGroup.get(group);
      if (!prior) {
        continuity = "fresh";
        freshReason = "first-in-group";
      } else if (prior.claude === claude) {
        continuity = "resumed";
      } else {
        continuity = "fresh";
        freshReason =
          prior.deviceId !== deviceId
            ? "different-device"
            : prior.status === "failed"
              ? "prior-failed"
              : "new-session";
      }
      lastByGroup.set(group, { claude, deviceId, status: s.status });
    }

    entries.push({
      id: s.id,
      jobType,
      group,
      groupLabel: group ? humanizeSessionGroup(group) : null,
      claudeSessionId: claude,
      claudeShort: claude ? claude.slice(0, 8) : null,
      deviceId,
      deviceShort: deviceId ? deviceId.slice(0, 8) : null,
      deviceName: s.deviceName ?? null,
      status: s.status,
      startedAt: s.startedAt ?? s.createdAt ?? null,
      continuity,
      freshReason,
      connectedToPrev: !!claude && claude === prevClaude,
    });

    prevClaude = claude;
  }

  return entries;
}

/** Human copy for a fresh-reason (operator detail, AC8). */
export const FRESH_REASON_COPY: Record<FreshReason, string> = {
  "first-in-group": "First step in this session group",
  "different-device": "Ran on a different device (device-pin drift)",
  "prior-failed": "Prior session in this group failed",
  "new-session": "Started a new Claude session",
};

/** Display metadata for each comment kind badge. */
export const COMMENT_KIND_META: Record<
  CommentKind,
  { label: string; tone: "neutral" | "accent" | "cobalt" | "green" | "red" | "amber" }
> = {
  triage: { label: "Triage", tone: "cobalt" },
  clarify: { label: "Clarify", tone: "cobalt" },
  plan: { label: "Plan", tone: "cobalt" },
  code: { label: "Code", tone: "accent" },
  review: { label: "Review", tone: "amber" },
  changes: { label: "Changes", tone: "red" },
  fix: { label: "Fix", tone: "accent" },
  approved: { label: "Approved", tone: "green" },
  qa: { label: "QA", tone: "amber" },
  released: { label: "Released", tone: "green" },
  comment: { label: "Comment", tone: "neutral" },
};
