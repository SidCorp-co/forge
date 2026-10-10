"use client";

// The triage checklist's questions a triager answers (Feedback lifecycle r14 triage-check), drawn from
// the one definition core judges them by (`@forge/contracts/checklists:checklistFormOf`), so the form
// asks exactly what the check asks (REQ-34 BC-3). Each refusal on `/answers/<question>` is shown on its
// own field. The route is the triage's own choice; kind and requirement are the item's record.

import { FEEDBACK_TRIAGE_CHECKLIST } from "@forge/contracts/checklist-registry";
import { checklistFormOf } from "@forge/contracts/checklists";
import { TRIAGE_ROUTE_QUESTION, type TriageAnswers } from "@forge/contracts/feedback-triage";
import { Field, Input, NativeSelect, Textarea } from "@/design";
import { namedRefusals } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";

/** The questions the triager answers in `answers`, in the checklist's order. */
export const TRIAGE_ANSWER_FIELDS = checklistFormOf(FEEDBACK_TRIAGE_CHECKLIST).fields.filter(
  (f) => f.answeredBy === "mover" && f.name !== TRIAGE_ROUTE_QUESTION,
);

export type TriageAnswerDraft = Record<string, string>;

/** What a triage sends: each answer typed, trimmed; an empty one is left out for the check to name. */
export function answersOf(draft: TriageAnswerDraft): TriageAnswers {
  return Object.fromEntries(
    Object.entries(draft)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ""),
  );
}

export function TriageAnswerFields({
  value,
  onChange,
  error,
}: {
  value: TriageAnswerDraft;
  onChange: (next: TriageAnswerDraft) => void;
  error: unknown;
}) {
  const t = useCopy();
  const refused = namedRefusals(error);
  const set = (name: string, v: string) => onChange({ ...value, [name]: v });
  return (
    <div className="grid gap-2" data-testid="triage-answers">
      {TRIAGE_ANSWER_FIELDS.map((f) => {
        const fieldError = refused.find((r) => r.path === f.path)?.detail;
        const current = value[f.name] ?? "";
        return (
          <Field key={f.name} label={f.label} error={fieldError}>
            {f.control === "choice" ? (
              <NativeSelect
                aria-label={f.label}
                value={current}
                onChange={(e) => set(f.name, e.target.value)}
                options={[{ value: "", label: t("feedback.answers.pick") }, ...f.options]}
              />
            ) : (f.maxLength ?? 0) > 200 ? (
              <Textarea aria-label={f.label} rows={2} maxLength={f.maxLength ?? undefined} value={current} onChange={(e) => set(f.name, e.target.value)} />
            ) : (
              <Input
                aria-label={f.label}
                maxLength={f.maxLength ?? undefined}
                value={current}
                onChange={(e) => set(f.name, e.target.value)}
                placeholder={f.name === "criterion" ? t("feedback.answers.criterionPlaceholder") : undefined}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
