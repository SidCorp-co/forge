"use client";

// The issue description, read and written. Reading is `<BodyView>`, which draws
// a component body as components and a markdown body exactly as before.
// Writing is ISS-967 gap 4: `PATCH /api/issues/:id` has always accepted
// `description`, and until now nothing in the browser sent it, so a description
// typed wrong at create stayed wrong forever.

import { useState } from "react";
import { BodyView, Button, Skeleton, StaleReadLine } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { couldNotRefresh, offersRetry } from "@/lib/api/read-failed";
import type { AttachmentRow, IssueDetail } from "../types";
import { AttachmentList } from "./attachment-list";
import { BodyEditor } from "./body-editor";
import { FlatSection } from "./flat-section";
import { heldByAgent } from "../edit-lock";
import { useSaveDescription } from "../hooks";

export interface DescriptionSectionProps {
  issue: IssueDetail;
  attachments: AttachmentRow[];
  canWrite: boolean;
  attachmentsLoading?: boolean;
  /** A failed attachments read, said as such rather than drawn as none. */
  attachmentsError?: unknown;
  /** Read the attachments again, offered where retrying could change the answer (ISS-1160). */
  onRetryAttachments?: (() => void) | undefined;
  /** When the attachments still listed were read, where their read answered before it failed (ISS-1228 r26). */
  attachmentsReadAt?: number | undefined;
}

export function DescriptionSection({
  issue,
  attachments,
  canWrite,
  attachmentsLoading = false,
  attachmentsError = null,
  onRetryAttachments,
  attachmentsReadAt,
}: DescriptionSectionProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useSaveDescription(issue.id);
  const editing = draft !== null;
  const held = heldByAgent(issue.status, issue.agentStatus);

  const renderArtifact = (id: string) => {
    const row = attachments.find((a) => a.id === id);
    return row ? <AttachmentList rows={[row]} /> : null;
  };

  return (
    <FlatSection
      title="Description"
      action={
        // Held by an agent, Edit is withheld; the page says why once, above this section (ISS-1228 r26).
        canWrite &&
        !editing &&
        !held && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(issue.description ?? "")}>
            Edit
          </Button>
        )
      }
    >
      <IssueAttachments
        rows={attachments}
        loading={attachmentsLoading}
        error={attachmentsError}
        onRetry={onRetryAttachments}
        readAt={attachmentsReadAt}
      />
      {editing ? (
        <BodyEditor
          label="Issue description"
          value={draft}
          onChange={setDraft}
          disabled={save.isPending}
          placeholder="What is the problem, and what does done look like?"
          actions={
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              {/* A draft begun before the issue's read failed stays, but is not saved over what was not re-read (ISS-1228 r26). */}
              <Button
                variant="primary"
                size="sm"
                loading={save.isPending}
                disabled={!canWrite}
                onClick={() =>
                  canWrite &&
                  save.mutate(
                    { id: issue.id, body: { description: draft } },
                    { onSuccess: () => setDraft(null) },
                  )
                }
              >
                Save
              </Button>
            </div>
          }
        />
      ) : issue.description ? (
        <BodyView
          body={issue.description}
          format={issue.descriptionFormat}
          nodes={issue.descriptionNodes}
          renderArtifact={renderArtifact}
        />
      ) : (
        <p className="fg-body-sm text-muted">
          {canWrite && !held ? "No description yet — Edit adds one." : "No description."}
        </p>
      )}
    </FlatSection>
  );
}

/** The issue's attachments, above the text that refers to them; nothing at all when there are none. */
function IssueAttachments({
  rows,
  loading,
  error,
  onRetry,
  readAt,
}: {
  rows: AttachmentRow[];
  loading: boolean;
  error: unknown;
  onRetry: (() => void) | undefined;
  readAt: number | undefined;
}) {
  if (loading) {
    return (
      <div className="mb-4" aria-busy>
        <Skeleton variant="text" className="w-40" />
      </div>
    );
  }
  if (error && readAt) {
    return (
      <section aria-label="Attachments" className="mb-4 space-y-2">
        <StaleReadLine
          said={`Attachments: ${couldNotRefresh(readAt, error)}`}
          onRetry={onRetry && offersRetry(error) ? onRetry : undefined}
        />
        {rows.length > 0 && <AttachmentList rows={rows} />}
      </section>
    );
  }
  if (error) {
    return (
      <p role="alert" className="fg-body-sm mb-4 flex flex-wrap items-center gap-2 text-muted">
        <span>Couldn't load attachments — {formatApiError(error)}</span>
        {onRetry && isRetryableApiError(error) && (
          <Button variant="secondary" size="sm" icon="rerun" onClick={onRetry}>
            Retry
          </Button>
        )}
      </p>
    );
  }
  if (rows.length === 0) return null;
  return (
    <section aria-label="Attachments" className="mb-4">
      <AttachmentList rows={rows} />
    </section>
  );
}
