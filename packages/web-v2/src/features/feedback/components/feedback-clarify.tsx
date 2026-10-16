// Ask the reporter one clarification (`POST …/feedback/:fb/clarification`, Q5): the question, and what
// is needed back. Offered exactly where core's read says the route takes one (`can.clarify`: a
// writer, before the item is routed, while none is open); the open one and its answer are the rail's
// Clarification row. Core refuses a wrong send by name, shown on its field.

import { useState } from "react";
import { Button, Field, Input, Textarea } from "@/design";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFeedbackAction } from "../hooks";
import type { FeedbackView } from "../types";

const FIELDS = { prompt: ["/prompt"], needed: ["/needed"] } as const;

export function ClarifyReporter({ projectId, f }: { projectId: string; f: FeedbackView }) {
  const t = useCopy();
  const act = useFeedbackAction(projectId, f.key);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [needed, setNeeded] = useState("");
  const refused = placeRefusals(act.error, FIELDS);
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
          { kind: "clarify", prompt: prompt.trim(), needed: needed.trim() },
          {
            onSuccess: () => {
              setOpen(false);
              setPrompt("");
              setNeeded("");
            },
          },
        );
      }}
    >
      <h3 className="text-12 font-semibold text-muted">{t("feedback.clarify.title")}</h3>
      <Field label={t("feedback.clarify.prompt")} error={refused.at("prompt")} required>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} maxLength={2000} data-testid="feedback-clarify-prompt" />
      </Field>
      <Field label={t("feedback.clarify.needed")} error={refused.at("needed")} required>
        <Input value={needed} onChange={(e) => setNeeded(e.target.value)} maxLength={1000} data-testid="feedback-clarify-needed" />
      </Field>
      <RefusalLine error={act.error} onField={refused.onField} testid="feedback-clarify-refusal" />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" loading={act.isPending} disabled={!prompt.trim() || !needed.trim()}>
          {t("feedback.clarify.send")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={act.isPending}>
          {t("feedback.form.cancel")}
        </Button>
      </div>
    </form>
  );
}
