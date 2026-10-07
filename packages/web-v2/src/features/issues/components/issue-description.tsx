"use client";

// The issue description, read and written. Reading is `<BodyView>`, which draws
// a component body as components and a markdown body exactly as before.
// Writing is ISS-967 gap 4: `PATCH /api/issues/:id` has always accepted
// `description`, and until now nothing in the browser sent it, so a description
// typed wrong at create stayed wrong forever.

import { useState } from "react";
import { BodyView, Button, Skeleton, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { AttachmentRow, IssueDetail } from "../types";
import { AttachmentList } from "./attachment-list";
import { BodyEditor } from "./body-editor";
import { agentHoldsEdit, heldByAgent } from "../edit-lock";
import { useSaveDescription } from "../hooks";

interface IssueDescriptionProps {
  issue: IssueDetail;
  attachments: AttachmentRow[];
  canWrite: boolean;
  attachmentsLoading?: boolean;
  /** A failed attachments read, said as such rather than drawn as none. */
  attachmentsError?: unknown;
}

export function IssueDescription({
  issue,
  attachments,
  canWrite,
  attachmentsLoading = false,
  attachmentsError = null,
}: IssueDescriptionProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = useSaveDescription(issue.id);
  const editing = draft !== null;
  const held = heldByAgent(issue.status, issue.agentStatus);
  const t = useCopy();

  const renderArtifact = (id: string) => {
    const row = attachments.find((a) => a.id === id);
    return row ? <AttachmentList rows={[row]} /> : null;
  };

  return (
    <section aria-label={t("issues.description.title")} data-testid="issue-description">
      <ViewHeading
        right={
          canWrite && !editing ? (
            held ? (
              <span role="status" className="fg-body-sm text-subtle">
                {agentHoldsEdit(t)}
              </span>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setDraft(issue.description ?? "")}>
                {t("issues.rail.edit")}
              </Button>
            )
          ) : undefined
        }
      >
        {t("issues.description.title")}
      </ViewHeading>
      <IssueAttachments rows={attachments} loading={attachmentsLoading} error={attachmentsError} />
      {editing ? (
        <BodyEditor
          label={t("issues.description.label")}
          value={draft}
          onChange={setDraft}
          disabled={save.isPending}
          placeholder={t("issues.description.placeholder")}
          actions={
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={save.isPending}
                onClick={() => setDraft(null)}
              >
                {t("common.cancel")}
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
                {t("issues.description.save")}
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
          {canWrite ? t("issues.description.emptyWritable") : t("issues.description.empty")}
        </p>
      )}
    </section>
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
  const t = useCopy();
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
        {t("issues.attachments.loadFailed", { error: formatApiError(error) })}
      </p>
    );
  }
  if (rows.length === 0) return null;
  return (
    <section aria-label={t("issues.attachments.title")} className="mb-4">
      <AttachmentList rows={rows} />
    </section>
  );
}
