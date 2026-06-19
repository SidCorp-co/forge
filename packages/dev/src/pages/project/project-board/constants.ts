import type { IssueStatus, KanbanColumn as KanbanCol } from "@/lib/types";

export const ALL_ISSUE_COLS: { status: IssueStatus; label: string; color: string; bg: string }[] = [
  { status: "draft", label: "Draft", color: "border-slate-300", bg: "bg-slate-50" },
  { status: "open", label: "Open", color: "border-gray-400", bg: "bg-gray-50" },
  { status: "confirmed", label: "Confirmed", color: "border-blue-400", bg: "bg-blue-50" },
  { status: "clarified", label: "Clarified", color: "border-cyan-400", bg: "bg-cyan-50" },
  { status: "waiting", label: "Waiting", color: "border-sky-400", bg: "bg-sky-50" },
  { status: "approved", label: "Approved", color: "border-indigo-400", bg: "bg-indigo-50" },
  { status: "in_progress", label: "In Progress", color: "border-yellow-400", bg: "bg-yellow-50" },
  { status: "developed", label: "Developed", color: "border-emerald-400", bg: "bg-emerald-50" },
  { status: "deploying", label: "Deploying", color: "border-cyan-400", bg: "bg-cyan-50" },
  { status: "testing", label: "Testing", color: "border-purple-400", bg: "bg-purple-50" },
  { status: "tested", label: "Tested", color: "border-teal-400", bg: "bg-teal-50" },
  { status: "released", label: "Released", color: "border-green-400", bg: "bg-green-50" },
  { status: "closed", label: "Closed", color: "border-slate-400", bg: "bg-slate-50" },
  { status: "reopen", label: "Reopen", color: "border-amber-400", bg: "bg-amber-50" },
  { status: "on_hold", label: "On Hold", color: "border-orange-400", bg: "bg-orange-50" },
  { status: "needs_info", label: "Needs Info", color: "border-rose-400", bg: "bg-rose-50" },
];

export const TASK_COLS: { status: KanbanCol; label: string; color: string; bg: string }[] = [
  { status: "backlog", label: "Backlog", color: "border-gray-400", bg: "bg-gray-50" },
  { status: "todo", label: "Todo", color: "border-blue-400", bg: "bg-blue-50" },
  { status: "in_progress", label: "In Progress", color: "border-yellow-400", bg: "bg-yellow-50" },
  { status: "in_review", label: "In Review", color: "border-purple-400", bg: "bg-purple-50" },
  { status: "done", label: "Done", color: "border-green-400", bg: "bg-green-50" },
];

export const DEFAULT_VISIBLE: Record<IssueStatus, boolean> = {
  draft: true, open: true, confirmed: true, clarified: true, waiting: true,
  approved: true, in_progress: true, developed: true, deploying: true, testing: true,
  tested: true, released: false, closed: false,
  reopen: true, on_hold: true, needs_info: false,
};
