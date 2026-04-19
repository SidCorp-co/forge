import clsx from "clsx";
import type { Issue, IssueStatus } from "@/lib/types";
import { ALL_STATUSES, STATUS_COLORS } from "@/lib/constants";

export function InlineStatusSelect({ issue, onUpdate }: { issue: Issue; onUpdate: (id: string, data: Partial<Issue>) => void }) {
  return (
    <select
      value={issue.status}
      onChange={(e) => onUpdate(issue.documentId, { status: e.target.value as IssueStatus })}
      onClick={(e) => e.stopPropagation()}
      className={clsx("rounded px-2 py-0.5 text-xs font-medium border-0 cursor-pointer", STATUS_COLORS[issue.status])}
    >
      {ALL_STATUSES.map((s) => (
        <option key={s.value} value={s.value}>{s.label}</option>
      ))}
    </select>
  );
}
