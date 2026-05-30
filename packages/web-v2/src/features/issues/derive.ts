// web-v2 feature module: issues — PURE derivations (unit-tested in
// `derive.test.ts`). No React, no IO: status → stage / chip / run, dependency
// counts, filter → server params, client grouping, comment-kind heuristic.

import type { StageKey } from "@/design/stages";
import type { StatusKey } from "@/design/status";
import type {
  CommentKind,
  GroupBy,
  IssueAgentStatus,
  IssueDependencies,
  IssueFilter,
  IssueRow,
  IssueStatus,
} from "./types";

/**
 * Map a core issue status to a pipeline stage so the per-row mini tracker
 * reflects where the issue sits. Ported from the project overview page's
 * `STATUS_TO_STAGE` (`(workspace)/projects/[slug]/page.tsx`).
 */
export const STATUS_TO_STAGE: Record<IssueStatus, StageKey> = {
  open: "triage",
  needs_info: "triage",
  confirmed: "triage",
  draft: "triage",
  waiting: "clarify",
  approved: "plan",
  in_progress: "code",
  reopen: "code",
  developed: "review",
  deploying: "test",
  testing: "test",
  tested: "test",
  pass: "release",
  staging: "release",
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
    case "pass":
      return "passed";
    case "staging":
    case "released":
    case "closed":
      return "done";
    case "on_hold":
      return "paused";
    default:
      return "queued";
  }
}

export interface DepCounts {
  blockedBy: number;
  blocks: number;
}

/**
 * Dependency badge counts for an issue. `blocks` edges encode "from blocks to"
 * (dispatcher convention). For issue `id`: it is BLOCKED-BY each incoming
 * `blocks` edge, and it BLOCKS each outgoing `blocks` edge.
 */
export function depCounts(deps: IssueDependencies | undefined): DepCounts {
  if (!deps) return { blockedBy: 0, blocks: 0 };
  const blockedBy = deps.incoming.filter((e) => e.kind === "blocks").length;
  const blocks = deps.outgoing.filter((e) => e.kind === "blocks").length;
  return { blockedBy, blocks };
}

/**
 * Translate a filter tab into server `status`/`statusNot` arrays.
 * - all: hide drafts + closed
 * - active: the in-flight lifecycle band
 * - review: developed/deploying/testing/tested
 * - blocked: on_hold + needs_info (work parked / waiting on input)
 */
export function filterToStatusParams(filter: IssueFilter): {
  status?: IssueStatus[];
  statusNot?: IssueStatus[];
} {
  switch (filter) {
    case "active":
      return { status: ["open", "confirmed", "waiting", "approved", "in_progress", "reopen"] };
    case "review":
      return { status: ["developed", "deploying", "testing", "tested", "pass", "staging"] };
    case "blocked":
      return { status: ["on_hold", "needs_info"] };
    default:
      return { statusNot: ["draft", "closed"] };
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
