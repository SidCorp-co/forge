import type { IssueStatus, IssuePriority } from "@/lib/types";

export const CONTEXT_LIMIT = 1_000_000;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const PRIORITY_COLORS: Record<IssuePriority, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-yellow-100 text-yellow-700",
  low: "bg-gray-100 text-gray-600",
  none: "bg-gray-50 text-gray-400",
};

export const ALL_PRIORITIES: { value: IssuePriority; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "none", label: "None" },
];

export const ALL_STATUSES: { value: IssueStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "confirmed", label: "Confirmed" },
  { value: "clarified", label: "Clarified" },
  { value: "waiting", label: "Waiting" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In Progress" },
  { value: "developed", label: "Developed" },
  { value: "deploying", label: "Deploying" },
  { value: "testing", label: "Testing" },
  { value: "staging", label: "Staging" },
  { value: "released", label: "Released" },
  { value: "closed", label: "Closed" },
  { value: "reopen", label: "Reopen" },
  { value: "on_hold", label: "On Hold" },
  { value: "needs_info", label: "Needs Info" },
];

export const STATUS_COLORS: Record<IssueStatus, string> = {
  draft: "bg-slate-50 text-slate-400",
  open: "bg-gray-100 text-gray-700",
  confirmed: "bg-indigo-50 text-indigo-700",
  clarified: "bg-cyan-50 text-cyan-700",
  waiting: "bg-amber-50 text-amber-700",
  approved: "bg-green-50 text-green-700",
  in_progress: "bg-orange-50 text-orange-700",
  developed: "bg-emerald-50 text-emerald-700",
  deploying: "bg-blue-50 text-blue-700",
  testing: "bg-purple-50 text-purple-700",
  staging: "bg-cyan-50 text-cyan-700",
  released: "bg-teal-100 text-teal-700",
  closed: "bg-gray-50 text-gray-500",
  reopen: "bg-amber-100 text-amber-700",
  on_hold: "bg-yellow-100 text-yellow-700",
  needs_info: "bg-purple-100 text-purple-700",
};

export const ALL_CATEGORIES: { value: string; label: string }[] = [
  { value: "bug", label: "Bug" },
  { value: "feature", label: "Feature" },
  { value: "improvement", label: "Improvement" },
  { value: "task", label: "Task" },
];

export const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};
