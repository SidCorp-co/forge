// Every question about this feedback item, open and answered, read on the item itself (REQ-33 BC-8):
// the clarifications asked of its reporter and the steward's questions about it, newest first, each
// with what came back. There is no Questions page; one waiting on the viewer is also in Approvals.

import { StatusBadge } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { FeedbackView } from "../types";

export function FeedbackQuestions({ f }: { f: Pick<FeedbackView, "questions"> }) {
  const t = useCopy();
  const time = useTimeFormat();
  if (f.questions.length === 0) return null;
  return (
    <section className="grid gap-2" data-testid="feedback-questions">
      <h2 className="text-14 font-semibold leading-snug text-fg">
        {t("feedback.questions.heading")} <span className="font-normal text-muted">· {f.questions.length}</span>
      </h2>
      <ul className="m-0 grid list-none divide-y divide-line-subtle border-y border-line-subtle p-0">
        {f.questions.map((q) => (
          <li key={q.id} className="grid gap-1 py-2.5" data-testid="feedback-question" data-status={q.status}>
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="min-w-0 flex-1 break-words text-13-5 text-fg">{q.prompt ?? t("feedback.questions.withheld")}</span>
              <StatusBadge family="question" value={q.status} />
            </span>
            <span className="text-12 text-muted">
              {t(q.kind === "clarification" ? "feedback.questions.toReporter" : "feedback.questions.bySteward")} · {time.relative(q.askedAt)}
            </span>
            {q.answer ? <span className="break-words text-13 text-fg">{t("feedback.questions.answer", { answer: q.answer })}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
