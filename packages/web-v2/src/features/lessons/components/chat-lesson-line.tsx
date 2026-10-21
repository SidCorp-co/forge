// The lesson lines a chat draws (REQ-50 BC-1, BC-4). Under a person's reply the classifier kept as a
// correction: "Kept as a correction · Not a correction", so a person sees it and can take it back.
// Under an answer: the lessons it applied, each with "Wrongly applied", which holds the lesson.

import { useState } from "react";
import { RejectStep } from "@/features/suggestions";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useChatLessonMarks, useDismissCorrection, useMarkWronglyApplied } from "../hooks";

const LINK = "underline decoration-line-strong underline-offset-2 hover:text-fg";

function Kept({ projectId, id, dismissed, reason }: { projectId: string; id: string; dismissed: boolean; reason: string }) {
  const t = useCopy();
  const dismiss = useDismissCorrection(projectId);
  return (
    <p className="mt-1 text-right text-12 text-subtle" title={reason} data-testid="chat-lesson-correction">
      {dismissed ? (
        t("lessons.chat.dismissed")
      ) : (
        <>
          {t("lessons.chat.kept")} ·{" "}
          <button type="button" className={LINK} disabled={dismiss.isPending} onClick={() => dismiss.mutate(id)} data-testid="chat-lesson-dismiss">
            {t("lessons.act.dismiss")}
          </button>
        </>
      )}
      {dismiss.isError ? <span className="block text-danger">{formatApiError(dismiss.error)}</span> : null}
    </p>
  );
}

function Applied({ projectId, items }: { projectId: string; items: { id: string; lessonKey: string; wrong: boolean }[] }) {
  const t = useCopy();
  const [marking, setMarking] = useState<string | null>(null);
  const mark = useMarkWronglyApplied(projectId);
  return (
    <div className="mt-1 grid gap-1 text-12 text-subtle" data-testid="chat-lessons-applied">
      <p>
        {t("lessons.chat.applied")}:{" "}
        {items.map((a, i) => (
          <span key={a.id}>
            {i > 0 ? ", " : ""}
            <span className="font-mono">{a.lessonKey}</span>{" "}
            {a.wrong ? (
              `(${t("lessons.chat.wrongDone")})`
            ) : (
              <button type="button" className={LINK} onClick={() => setMarking(a.id)} data-testid="chat-lesson-wrong">
                {t("lessons.act.wrong")}
              </button>
            )}
          </span>
        ))}
      </p>
      {marking ? (
        <RejectStep
          label={t("lessons.act.wrong")}
          reasonLabel={t("lessons.wrongWhy")}
          loading={mark.isPending}
          onCancel={() => setMarking(null)}
          onConfirm={(reason) => mark.mutate({ id: marking, reason }, { onSuccess: () => setMarking(null) })}
        />
      ) : null}
      {mark.isError ? <span className="text-danger">{formatApiError(mark.error)}</span> : null}
    </div>
  );
}

/** What one message of a project chat shows about lessons; nothing when it neither corrected nor applied one. */
export function ChatLessonLine({ projectId, conversationId, messageId }: { projectId: string; conversationId: string; messageId: string }) {
  const marks = useChatLessonMarks(projectId, conversationId).data;
  if (!marks) return null;
  const kept = marks.corrections.find((c) => c.messageId === messageId);
  const applied = marks.applied.filter((a) => a.messageId === messageId);
  return (
    <>
      {kept ? <Kept projectId={projectId} id={kept.id} dismissed={kept.dismissed} reason={kept.reason} /> : null}
      {applied.length > 0 ? <Applied projectId={projectId} items={applied} /> : null}
    </>
  );
}
