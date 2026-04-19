import { Link } from "react-router-dom";
import { StatusBadge } from "./status-badge";
import type { Issue } from "@/lib/types";

interface IssueListItemProps {
  issue: Issue;
  to: string;
}

export function IssueListItem({ issue, to }: IssueListItemProps) {
  return (
    <li>
      <Link
        to={to}
        className="block rounded-lg border border-gray-200 bg-white p-4 transition hover:shadow-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium text-gray-900">
            <span className="mr-1.5 font-mono text-xs text-gray-400">ISS-{issue.id}</span>
            {issue.title}
          </span>
          <StatusBadge status={issue.status} />
        </div>
        <p className="mt-1 text-xs text-gray-500">
          {issue.priority !== "none" ? `${issue.priority} priority` : "No priority"}
          {issue.project ? ` · ${issue.project.name}` : ""}
        </p>
      </Link>
    </li>
  );
}
