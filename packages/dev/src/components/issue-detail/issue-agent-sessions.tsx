import type { Issue } from "@/lib/types";
import { StatusBadge } from "../ui/status-badge";

interface Props {
  issue: Issue;
  slug: string;
  onClose: () => void;
  navigate: (path: string) => void;
}

export function IssueAgentSessions({ issue, slug, onClose, navigate }: Props) {
  if (!issue.agentSessions || issue.agentSessions.length === 0) return null;

  return (
    <div className="px-6 py-3">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">Agent Sessions</h3>
      <ul className="space-y-1.5">
        {issue.agentSessions.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => { onClose(); navigate(`/project/${slug}/agent?sessionId=${s.documentId}`); }}
              className="flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-left text-sm hover:bg-gray-100"
            >
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
              </svg>
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
              <StatusBadge status={s.status} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
