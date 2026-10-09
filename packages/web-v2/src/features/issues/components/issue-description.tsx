"use client";

// The issue description, read and written. Reading is `<BodyView>`, which draws
// a component body as components and a markdown body exactly as before.
// Writing is ISS-967 gap 4: `PATCH /api/issues/:id` has always accepted
// `description`, and until now nothing in the browser sent it, so a description
// typed wrong at create stayed wrong forever.

import { WrittenMark } from "@/lib/i18n/written";
import { useState } from "react";
import { BodyView, Button } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { AttachmentRow, IssueDetail } from "../types";
import { AttachmentList } from "@/features/attachments/components/attachment-list";
import { BodyEditor } from "./body-editor";
import { agentHoldsEdit, heldByAgent } from "../edit-lock";
import { useSaveDescription } from "../hooks";

interface IssueDescriptionProps {
  issue: IssueDetail;
  attachments: AttachmentRow[];
  canWrite: boolean;
}

export function IssueDescription({ issue, attachments, canWrite }: IssueDescriptionProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
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
      <div className="mb-2 flex items-center justify-end gap-2">
        <WrittenMark lang={issue.writtenLang} />
        {canWrite && !editing ? (
          <Button variant="ghost" size="sm" onClick={() => (held ? setRefused(true) : setDraft(issue.description ?? ""))}>
            {t("issues.rail.edit")}
          </Button>
        ) : null}
      </div>
      {refused && held ? (
        <p role="status" className="fg-body-sm mb-3 text-subtle">
          {agentHoldsEdit(t)}
        </p>
      ) : null}
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
        <div lang={issue.writtenLang ?? undefined}>
          <BodyView body={issue.description} format={issue.descriptionFormat} nodes={issue.descriptionNodes} renderArtifact={renderArtifact} />
        </div>
      ) : (
        <p className="fg-body-sm text-muted">
          {canWrite ? t("issues.description.emptyWritable") : t("issues.description.empty")}
        </p>
      )}
    </section>
  );
}
