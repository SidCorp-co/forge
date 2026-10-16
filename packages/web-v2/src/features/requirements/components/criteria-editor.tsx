// A revision's criteria written one by one: each a statement, or a scenario whose Given, When and Then
// steps are written a line each. A refusal core names at a criterion (`/criteria/<i>/…`) is drawn on
// that criterion; the codes ride along unseen, so a kept criterion stays the criterion it was.

import { Button, Field, IconButton, SegmentedControl, Textarea, useListKeys } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { blankCriterion, type CriterionDraft, SCENARIO_PARTS, type ScenarioPart, withForm } from "../revision-draft";

const PART_KEY = { given: "requirements.revise.given", when: "requirements.revise.when", then: "requirements.revise.then" } as const;

function ScenarioStepsField({ part, steps, onChange }: { part: ScenarioPart; steps: string[]; onChange: (steps: string[]) => void }) {
  const t = useCopy();
  return (
    <Field label={t(PART_KEY[part])}>
      <Textarea rows={2} value={steps.join("\n")} onChange={(e) => onChange(e.target.value.split("\n"))} data-testid={`criterion-${part}`} />
    </Field>
  );
}

function CriterionItem({
  c,
  n,
  error,
  onChange,
  onRemove,
}: {
  c: CriterionDraft;
  n: number;
  /** Core's words for a refusal at this criterion. */
  error: string | undefined;
  onChange: (c: CriterionDraft) => void;
  onRemove: () => void;
}) {
  const t = useCopy();
  return (
    <li className="grid gap-2 border-b border-line-subtle py-3" data-testid="criterion-draft" data-form={c.form}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-12 font-semibold text-muted">{t("requirements.revise.criterionN", { n })}</span>
        <SegmentedControl
          options={[
            { value: "statement", label: t("requirements.revise.statement") },
            { value: "scenario", label: t("requirements.revise.scenario") },
          ]}
          value={c.form}
          onChange={(form) => onChange(withForm(c, form))}
        />
        <span className="flex-1" />
        <IconButton icon="trash" size="sm" aria-label={t("requirements.revise.removeN", { n })} onClick={onRemove} />
      </div>
      {c.form === "statement" ? (
        <Field label={t("requirements.revise.statementLabel", { n })} error={error}>
          <Textarea rows={2} value={c.body} onChange={(e) => onChange({ ...c, body: e.target.value })} />
        </Field>
      ) : (
        <div className="grid gap-2 border-l-2 border-line pl-3" role="group" aria-label={t("requirements.revise.stepsOfN", { n })}>
          {SCENARIO_PARTS.map((part) => (
            <ScenarioStepsField key={part} part={part} steps={c.steps[part]} onChange={(steps) => onChange({ ...c, steps: { ...c.steps, [part]: steps } })} />
          ))}
          {error ? (
            <p role="alert" className="text-12 text-danger-11">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** The criteria rows, each with its refusal; adding one appends a blank statement. */
export function CriteriaEditor({ rows, onChange, errorAt }: { rows: CriterionDraft[]; onChange: (rows: CriterionDraft[]) => void; errorAt: (index: number) => string | undefined }) {
  const t = useCopy();
  const keys = useListKeys(rows.length);
  return (
    <div data-testid="criteria-editor">
      <ol>
        {rows.map((c, i) => (
          <CriterionItem
            key={keys.keys[i]}
            c={c}
            n={i + 1}
            error={errorAt(i)}
            onChange={(next) => onChange(rows.map((r, j) => (j === i ? next : r)))}
            onRemove={() => {
              keys.removed(i);
              onChange(rows.filter((_, j) => j !== i));
            }}
          />
        ))}
      </ol>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        icon="plus"
        className="mt-2"
        onClick={() => {
          keys.added();
          onChange([...rows, blankCriterion()]);
        }}
      >
        {t("requirements.revise.addCriterion")}
      </Button>
    </div>
  );
}
