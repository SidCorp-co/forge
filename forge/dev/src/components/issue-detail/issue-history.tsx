import type { Issue } from "@/lib/types";
import { StatusBadge } from "../ui/status-badge";

interface Props {
  issue: Issue;
}

export function IssueHistory({ issue }: Props) {
  if (!issue.changeHistory || issue.changeHistory.length === 0) return null;

  return (
    <div className="px-6 py-4">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">History</h3>
      <ul className="space-y-1">
        {issue.changeHistory.map((entry, i) => (
          <li key={i} className="flex items-baseline gap-1.5 text-xs text-gray-500">
            <span className="shrink-0 text-[10px] text-gray-400">{new Date(entry.at).toLocaleString()}</span>
            <span>
              <span className="font-medium text-gray-600">{entry.by}</span>
              {" changed "}
              <span className="font-medium">{entry.field}</span>
              {" from "}
              {entry.field === "status" || entry.field === "priority" ? (
                <StatusBadge status={entry.from ?? "none"} />
              ) : (
                <span className="rounded bg-gray-100 px-1 py-0.5">{entry.from ?? "none"}</span>
              )}
              {" to "}
              {entry.field === "status" || entry.field === "priority" ? (
                <StatusBadge status={entry.to} />
              ) : (
                <span className="rounded bg-gray-100 px-1 py-0.5">{entry.to}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
