"use client";

// The issue description, read and written. Reading is `<BodyView>`, which draws
// a component body as components and a markdown body exactly as before.
// Writing is ISS-967 gap 4: `PATCH /api/issues/:id` has always accepted
// `description`, and until now nothing in the browser sent it, so a description
// typed wrong at create stayed wrong forever.

import { useState } from "react";
import {
  BodyView,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import type { AttachmentRow, IssueDetail } from "../types";
import { AttachmentList } from "./attachment-list";
import { BodyEditor } from "./body-editor";
import { AGENT_HOLDS_EDIT, heldByAgent } from "../edit-lock";
import { useSaveDescription } from "../hooks";

export interface DescriptionCardProps {
  issue: IssueDetail;
  attachments: AttachmentRow[];
  canWrite: boolean;
  attachmentsLoading?: boolean;
  /** A failed attachments read, said as such rather than drawn as none. */
  attachmentsError?: unknown;
}

export function DescriptionCard({
  issue,
  attachments,
  canWrite,
  attachmentsLoading = false,
  attachmentsError = null,
}: DescriptionCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useSaveDescription(issue.id);
  const editing = draft !== null;
  const held = heldByAgent(issue.status, issue.agentStatus);

  const renderArtifact = (id: string) => {
    const row = attachments.find((a) => a.id === id);
    return row ? <AttachmentList rows={[row]} /> : null;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Description</CardTitle>
          {canWrite &&
            !editing &&
            (held ? (
              <span role="status" className="fg-body-sm text-subtle">
                {AGENT_HOLDS_EDIT}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft(issue.description ?? "")}
              >
                Edit
              </Button>
            ))}
        </div>
      </CardHeader>
      <CardContent>
        <IssueAttachments rows={attachments} loading={attachmentsLoading} error={attachmentsError} />
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
                <Button
                  variant="primary"
                  size="sm"
                  loading={save.isPending}
                  onClick={() =>
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
            {canWrite ? "No description yet — Edit adds one." : "No description."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** The issue's attachments, above the text that refers to them; nothing at all when there are none. */
function IssueAttachments({
  rows,
  loading,
  error,
}: {
  rows: AttachmentRow[];
  loading: boolean;
  error: unknown;
}) {
  if (loading) {
    return (
      <div className="mb-4" aria-busy>
        <Skeleton variant="text" className="w-40" />
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="fg-body-sm mb-4 text-muted">
        Couldn't load attachments — {formatApiError(error)}
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
