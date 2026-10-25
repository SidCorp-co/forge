// Ask the reporter one clarification (`POST …/feedback/:fb/clarification`, Q5): the question, what is
// needed back, and the answer you recommend, which the reporter sends by one click (REQ-66 BC-4). Offered exactly where core's read says the route takes one (`can.clarify`: a
// writer, before the item is routed, while none is open); the open one and its answer are the rail's
// Clarification row. Send waits until every field meets the contract's limits (ISS-539); core refuses
// a wrong send by name all the same, shown on its field.

import { FEEDBACK_CLARIFICATION_LIMITS as LIMITS, feedbackClarificationRequestSchema } from "@forge/contracts/feedback";
import { useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFeedbackAction } from "../hooks";
import type { FeedbackView } from "../types";

const FIELDS = { prompt: ["/prompt"], needed: ["/needed"], recommended: ["/recommended"] } as const;

export function ClarifyReporter({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [needed, setNeeded] = useState("");
  const [recommended, setRecommended] = useState("");
  const refused = placeRefusals(act.error, FIELDS);
  const sendable = feedbackClarificationRequestSchema.safeParse({ prompt, needed, recommended }).success;
  if (!f.can.clarify) return null;
  if (!open) {
    return (
      <div data-testid="feedback-clarify">
        <Button type="button" variant="secondary" size="sm" icon="chat" onClick={() => setOpen(true)} data-testid="feedback-clarify-open">
          {t("feedback.clarify.open")}
        </Button>
      </div>
    );
  }
  return (
    <form
      className="grid max-w-2xl gap-3"
      data-testid="feedback-clarify"
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate(
          { kind: "clarify", prompt: prompt.trim(), needed: needed.trim(), recommended: recommended.trim() },
          {
            onSuccess: () => {
              setOpen(false);
              setPrompt("");
              setNeeded("");
              setRecommended("");
            },
          },
        );
      }}
    >
      <h3 className="text-12 font-semibold text-muted">{t("feedback.clarify.title")}</h3>
      <Field label={t("feedback.clarify.prompt")} error={refused.at("prompt")} required>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} maxLength={LIMITS.prompt.max} data-testid="feedback-clarify-prompt" />
      </Field>
      <Field label={t("feedback.clarify.needed")} error={refused.at("needed")} required>
        <Input value={needed} onChange={(e) => setNeeded(e.target.value)} maxLength={LIMITS.needed.max} data-testid="feedback-clarify-needed" />
      </Field>
      <Field label={t("feedback.clarify.recommended")} error={refused.at("recommended")} required>
        <Input value={recommended} onChange={(e) => setRecommended(e.target.value)} maxLength={LIMITS.recommended.max} data-testid="feedback-clarify-recommended" />
      </Field>
      <RefusalLine error={act.error} onField={refused.onField} testid="feedback-clarify-refusal" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={act.isPending} disabled={!sendable}>
          {t("feedback.clarify.send")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={act.isPending}>
          {t("feedback.form.cancel")}
        </Button>
      </div>
    </form>
  );
}
