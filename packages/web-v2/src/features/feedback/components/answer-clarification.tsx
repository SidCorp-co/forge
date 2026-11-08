// The reporter's answer to the clarification it is shown (REQ-66 BC-4, ISS-695): the answer the asker
// recommends stands in the field, so one click sends it and the reporter may write over it first.
// Offered exactly where core's read says the answer is taken (`can.answerClarification`: the item's
// reporter, a project writer, while the question is open); core refuses a wrong send by name all the
// same, shown under the field.

import { useState } from "react";
import { Button, Input } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAnswerClarification } from "../hooks";
import type { FeedbackView } from "../types";

export function AnswerClarification({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const asked = f.clarification;
  const send = useAnswerClarification(projectId, f.key);
  const [text, setText] = useState(asked?.recommended ?? "");
  if (!asked || !f.can.answerClarification) return null;
  return (
    <form
      className="grid w-full gap-1.5"
      data-testid="feedback-clarification-answer"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate({ questionId: asked.id, round: asked.round, text: text.trim() });
      }}
    >
      <Input value={text} onChange={(e) => setText(e.target.value)} aria-label={t("feedback.clarification.answer")} data-testid="feedback-clarification-text" />
      <RefusalLine error={send.error} testid="feedback-clarification-refusal" />
      <div>
        <Button type="submit" variant="primary" size="sm" loading={send.isPending} disabled={!text.trim()} data-testid="feedback-clarification-send">
          {t("feedback.clarification.send")}
        </Button>
      </div>
    </form>
  );
}
