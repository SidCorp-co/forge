"use client";

import { Button, SlideOver } from "@/design";
import { useBatchRelease } from "../hooks";

/** Minimal issue shape required by the dialog — avoids coupling to the full IssueRow. */
export interface BatchReleaseIssue {
  id: string;
  displayId: string;
  title: string;
}

export function BatchReleaseDialog({
  projectId,
  selectedIssues,
  open,
  onClose,
  onSuccess,
}: {
  projectId: string;
  selectedIssues: BatchReleaseIssue[];
  open: boolean;
  onClose: () => void;
  /** Called after a successful batch create so the parent can clear selection. */
  onSuccess: () => void;
}) {
  const batch = useBatchRelease(projectId);

  const handleConfirm = () => {
    const issueIds = selectedIssues.map((i) => i.id);
    batch.mutate(
      { issueIds },
      {
        onSuccess: () => {
          onClose();
          onSuccess();
        },
      },
    );
  };

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title="Batch release"
      width={400}
    >
      <div className="flex flex-col gap-4">
        <p className="fg-body-sm text-fg">
          The following {selectedIssues.length === 1 ? "issue" : `${selectedIssues.length} issues`} will
          be merged, deployed, and closed in one batch release. This cannot be undone.
        </p>

        <ul className="flex flex-col gap-1.5 rounded-lg border border-line bg-canvas p-3">
          {selectedIssues.map((issue) => (
            <li key={issue.id} className="fg-body-sm flex min-w-0 items-baseline gap-2">
              <span className="font-mono text-xs font-semibold text-fg shrink-0">{issue.displayId}</span>
              <span className="min-w-0 truncate text-muted">{issue.title}</span>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={batch.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            loading={batch.isPending}
            onClick={handleConfirm}
          >
            Release {selectedIssues.length > 0 ? `${selectedIssues.length} ` : ""}now
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}
