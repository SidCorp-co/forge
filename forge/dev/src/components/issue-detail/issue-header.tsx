import type { Issue } from "@/lib/types";
import { EditableField } from "../ui/editable-field";
import { CloseButton } from "../ui/close-button";

interface Props {
  issue: Issue;
  onClose: () => void;
  onUpdate: (id: string, data: Partial<Issue>) => void;
}

export function IssueHeader({ issue, onClose, onUpdate }: Props) {
  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-bold text-gray-900">
          <span className="font-mono text-sm text-gray-400">[ISS-{issue.id}]</span>{" "}
          {issue.title}
        </h2>
        <CloseButton onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-600" />
      </div>
      {issue.reportedBy && (
        <p className="mt-1 text-xs text-gray-400">Reported by {issue.reportedBy}</p>
      )}
      <div className="mt-2">
        <EditableField
          value={issue.description}
          placeholder="No description"
          editTitle="Edit description"
          onSave={(v) => onUpdate(issue.documentId, { description: v })}
        />
      </div>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Acceptance Criteria</h3>
          <EditableField
            value={issue.acceptanceCriteria}
            rows={4}
            editTitle="Edit acceptance criteria"
            onSave={(v) => onUpdate(issue.documentId, { acceptanceCriteria: v })}
          />
        </div>
        <div>
          <h3 className="mb-1 text-sm font-semibold text-gray-900">Suggested Solution</h3>
          <EditableField
            value={issue.suggestedSolution}
            rows={4}
            editTitle="Edit suggested solution"
            onSave={(v) => onUpdate(issue.documentId, { suggestedSolution: v })}
          />
        </div>
      </div>
    </div>
  );
}
