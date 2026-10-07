"use client";

// A feedback item's attachments: an image reads as a preview that opens the lightbox, any other file
// as a link, the way an issue comment shows its files; and, to whoever core says may, Attach — files
// staged by pick, drop or paste under the limits core's feedback attachment route keeps.

import { FEEDBACK_LIMITS } from "@forge/contracts/feedback";
import { Button, LEGEND } from "@/design";
import { AttachmentList } from "@/features/issues/components/attachment-list";
import { StagedFileList, useStagedFiles } from "@/features/issues/components/staged-files";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { AttachFailed } from "../api";
import { useAttachFeedback } from "../hooks";
import type { FeedbackView } from "../types";

const MB = FEEDBACK_LIMITS.attachmentBytes / 1024 / 1024;

/** The staging an item or a filing uses: the bytes and the count core's feedback route keeps. */
export function useFeedbackStaging(held: number) {
  return useStagedFiles({
    unit: "feedback",
    video: false,
    uniqueNames: false,
    maxBytes: FEEDBACK_LIMITS.attachmentBytes,
    maxFiles: FEEDBACK_LIMITS.attachmentsPerItem - held,
  });
}

export function FeedbackAttachments({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  // a duplicate's evidence is shown here but held on its own record, so only the item's own count
  const held = f.attachments.filter((a) => a.from === null).length;
  const staged = useFeedbackStaging(held);
  const attach = useAttachFeedback(projectId);
  const notes = f.attachments.filter((a) => a.from || a.flagged);
  const full = held >= FEEDBACK_LIMITS.attachmentsPerItem;
  const send = () =>
    attach.mutate({ key: f.key, files: staged.files }, { onSuccess: staged.reset });
  return (
    <div className="mt-4 grid gap-2" data-testid="feedback-attachments" onPaste={f.can.attach ? staged.onPaste : undefined}>
      {f.attachments.length > 0 ? <AttachmentList rows={f.attachments} /> : null}
      {notes.length > 0 ? (
        <ul className="grid gap-0.5 text-12">
          {notes.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono">{a.name}</span>
              {a.from ? <span className="text-muted">{t("feedback.body.from", { from: a.from })}</span> : null}
              {a.flagged ? (
                <span className="font-semibold" style={{ color: LEGEND.you.fg }} title={t("feedback.body.flaggedHint")}>
                  {t("feedback.body.flagged")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {f.can.attach ? (
        <div {...staged.dropZone} className={`grid gap-2 ${staged.dragOver ? "ring-2 ring-cobalt-400 ring-offset-1" : ""}`}>
          <StagedFileList files={staged.files} warnings={staged.warnings} remove={staged.remove} />
          <RefusalLine error={attach.error instanceof AttachFailed ? attach.error.refusal : attach.error} />
          <div className="flex flex-wrap items-center gap-2">
            {staged.files.length > 0 ? (
              <Button type="button" variant="primary" size="sm" loading={attach.isPending} onClick={send}>
                {staged.files.length === 1 ? t("feedback.attach.sendOne") : t("feedback.attach.sendMany", { n: staged.files.length })}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" icon="plus" onClick={staged.choose} disabled={full || attach.isPending}>
              {t("feedback.attach.choose")}
            </Button>
            {staged.input}
            <span className="text-12 text-subtle">
              {full
                ? t("feedback.attach.full", { n: held })
                : t("feedback.attach.hint", { mb: MB, n: FEEDBACK_LIMITS.attachmentsPerItem })}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
