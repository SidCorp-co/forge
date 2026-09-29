"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Banner, Button, SlideOver } from "@/design";
import { inlineCode } from "@/features/project-settings/components/inline-code";
import { formatApiError } from "@/lib/api/error";
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
  const openRef = useRef(open);
  openRef.current = open;
  const showsRefusal = useCallback(() => openRef.current, []);
  const batch = useBatchRelease(projectId, { showsRefusal });
  const { reset, isPending } = batch;
  const [refusal, setRefusal] = useState<{ message: string; tries: number } | null>(null);

  // A refusal belongs to the press that met it, so a dialog opened again starts clean; a press
  // still in flight is kept, since resetting it would leave its answer nowhere to land.
  const pendingRef = useRef(isPending);
  pendingRef.current = isPending;
  useEffect(() => {
    if (!open) return;
    setRefusal(null);
    if (!pendingRef.current) reset();
  }, [open, reset]);

  const handleConfirm = () => {
    const issueIds = selectedIssues.map((i) => i.id);
    batch.mutate(
      { issueIds },
      {
        onSuccess: () => {
          setRefusal(null);
          onClose();
          onSuccess();
        },
        onError: (err) =>
          setRefusal((prev) => ({ message: formatApiError(err), tries: (prev?.tries ?? 0) + 1 })),
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

        {/* A toast paints beneath this drawer's scrim, so the refusal is said here and only here. */}
        {refusal && (
          <div role="alert">
            <Banner tone="danger">
              {isPending ? (
                <p className="font-medium">Sending try {refusal.tries + 1}…</p>
              ) : refusal.tries > 1 ? (
                <p className="font-medium">Try {refusal.tries} failed as well.</p>
              ) : null}
              <p>{inlineCode(refusal.message)}</p>
            </Banner>
          </div>
        )}

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
