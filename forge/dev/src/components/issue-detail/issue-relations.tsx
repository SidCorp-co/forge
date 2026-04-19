import { useMemo } from "react";
import type { Issue } from "@/lib/types";

const RELATION_LABELS: Record<string, string> = {
  blocked_by: "Blocked by",
  blocks: "Blocks",
  depends_on: "Depends on",
  depended_on_by: "Depended on by",
  related_to: "Related to",
  duplicate_of: "Duplicate of",
  caused_by: "Caused by",
  fixed_by: "Fixed by",
};

const CLOSED_STATUSES = ["released", "closed"];

function StatusDot({ status }: { status?: string }) {
  const s = status ?? "open";
  const isClosed = CLOSED_STATUSES.includes(s);
  let color = "bg-green-500";
  if (isClosed) color = "bg-purple-500";
  else if (["in_progress", "developed", "deploying"].includes(s)) color = "bg-orange-500";
  else if (["testing", "staging"].includes(s)) color = "bg-blue-500";
  else if (s === "reopen") color = "bg-red-500";
  else if (["confirmed", "approved", "waiting"].includes(s)) color = "bg-sky-500";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} title={s} />;
}

interface Props {
  issue: Issue;
}

export function IssueRelations({ issue }: Props) {
  const relations = issue.relations;
  if (!relations || relations.length === 0) return null;

  const grouped = useMemo(() => {
    const map = new Map<string, typeof relations>();
    for (const r of relations) {
      const group = map.get(r.type) ?? [];
      group.push(r);
      map.set(r.type, group);
    }
    return map;
  }, [relations]);

  return (
    <div className="px-6 py-3">
      <div className="overflow-hidden rounded-md border border-gray-200">
        {[...grouped.entries()].map(([type, rels], gi) => (
          <div key={type}>
            <div className={`flex items-center gap-1.5 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-500 ${gi > 0 ? "border-t border-gray-200" : ""}`}>
              {RELATION_LABELS[type] ?? type}
              <span className="text-gray-400">({rels.length})</span>
            </div>
            {rels.map((r, ri) => (
              <div
                key={ri}
                className="flex items-center gap-2 border-t border-gray-100 px-3 py-1.5 text-sm"
              >
                <StatusDot status={r.targetStatus} />
                {r.targetId ? (
                  <>
                    <span className="shrink-0 font-medium text-gray-900">ISS-{r.targetId}</span>
                    <span className="min-w-0 truncate text-gray-600">{r.targetTitle}</span>
                  </>
                ) : (
                  <span className="font-mono text-gray-400">{r.targetDocumentId.slice(0, 8)}</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
