import clsx from "clsx";
import type { Issue, IssuePriority } from "@/lib/types";
import { ALL_PRIORITIES, PRIORITY_COLORS } from "@/lib/constants";

export function InlinePrioritySelect({ issue, onUpdate }: { issue: Issue; onUpdate: (id: string, data: Partial<Issue>) => void }) {
  return (
    <select
      value={issue.priority}
      onChange={(e) => onUpdate(issue.documentId, { priority: e.target.value as IssuePriority })}
      onClick={(e) => e.stopPropagation()}
      className={clsx("rounded px-2 py-0.5 text-xs font-medium border-0 cursor-pointer", PRIORITY_COLORS[issue.priority])}
    >
      {ALL_PRIORITIES.map((p) => (
        <option key={p.value} value={p.value}>{p.label}</option>
      ))}
    </select>
  );
}
