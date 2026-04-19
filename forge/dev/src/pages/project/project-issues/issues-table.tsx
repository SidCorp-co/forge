import clsx from "clsx";
import { AgentRunningDot, Button } from "@/components/ui";
import { InlineStatusSelect } from "@/components/issue/inline-status-select";
import { InlinePrioritySelect } from "@/components/issue/inline-priority-select";
import type { Issue } from "@/lib/types";

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

interface IssuesTableProps {
  issues: Issue[];
  checked: Set<string>;
  onRowClick: (issue: Issue) => void;
  onToggleCheck: (docId: string) => void;
  onToggleAll: () => void;
  onUpdate: (id: string, data: Partial<Issue>) => void;
  onEnrich: (documentId: string) => void;
}

export function IssuesTable({
  issues,
  checked,
  onRowClick,
  onToggleCheck,
  onToggleAll,
  onUpdate,
  onEnrich,
}: IssuesTableProps) {
  const allChecked = issues.length > 0 && issues.every((i) => checked.has(i.documentId));

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            <th className="px-3 py-3 w-10">
              <input
                type="checkbox"
                aria-label="Select all issues"
                checked={allChecked}
                onChange={onToggleAll}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
            </th>
            <th className="px-4 py-3 w-20">ID</th>
            <th className="px-4 py-3">Title</th>
            <th className="px-4 py-3 w-36">Status</th>
            <th className="px-4 py-3 w-32">Priority</th>
            <th className="px-4 py-3 w-28">Reporter</th>
            <th className="px-4 py-3 w-28">Updated</th>
            <th className="px-4 py-3 w-20"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {issues.map((issue) => (
            <tr
              key={issue.id}
              tabIndex={0}
              className={clsx("cursor-pointer hover:bg-gray-50", checked.has(issue.documentId) && "bg-blue-50/50")}
              onClick={() => onRowClick(issue)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onRowClick(issue);
                }
              }}
            >
              <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  aria-label={`Select issue ISS-${issue.id}`}
                  checked={checked.has(issue.documentId)}
                  onChange={() => onToggleCheck(issue.documentId)}
                  className="h-3.5 w-3.5 rounded border-gray-300"
                />
              </td>
              <td className="px-4 py-3">
                <span className="font-mono text-xs text-gray-400">ISS-{issue.id}</span>
              </td>
              <td className="px-4 py-3">
                <span className="font-medium text-gray-900">{issue.title}</span>
                {issue.agentStatus && issue.agentStatus !== "idle" && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-blue-600">
                    {issue.agentStatus === "running" && <AgentRunningDot size="sm" color="blue" />}
                    {issue.agentStatus}
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <InlineStatusSelect issue={issue} onUpdate={onUpdate} />
              </td>
              <td className="px-4 py-3">
                <InlinePrioritySelect issue={issue} onUpdate={onUpdate} />
              </td>
              <td className="px-4 py-3 text-xs text-gray-500">{issue.reportedBy ?? "-"}</td>
              <td className="px-4 py-3 text-xs text-gray-400">
                {dateFormatter.format(new Date(issue.updatedAt))}
              </td>
              <td className="px-4 py-3">
                {issue.status === "open" && (
                  <Button
                    size="sm"
                    onClick={(e) => { e.stopPropagation(); onEnrich(issue.documentId); }}
                    className="bg-blue-600 hover:bg-blue-700"
                  >
                    Enrich
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
