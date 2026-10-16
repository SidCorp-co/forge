// One field of a step or a line, owed or optional, written the way its value is shaped: a line of words, one entry
// per line, rows of a rule table, a closed choice, or — for what an agent draws (a wireframe, a field
// mapping) — kept as written and marked owed while it is missing. The words name the field as the
// design panel already reads it.

import { useState } from "react";
import { Button, Field, IconButton, Input, Select, Textarea, useListKeys } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { linesOf, shapeOf, UI_VARIANTS } from "../design-draft";

/** The words a field reads under, shared with the step panel's own. */
const FIELD_LABEL: Record<string, ProductCopyKey> = {
  purpose: "workflows.edit.field.purpose",
  inputs: "workflows.panel.inputs",
  outputs: "workflows.panel.outputs",
  owner: "workflows.owner",
  sla: "workflows.deadline",
  conditions: "workflows.edit.field.conditions",
  tests: "workflows.panel.checkedAgainst",
  expectedOutcome: "workflows.panel.expected",
  permissions: "workflows.panel.may",
  persona: "workflows.panel.persona",
  wireframe: "workflows.edit.field.wireframe",
  dataShown: "workflows.panel.shows",
  actions: "workflows.panel.offers",
  trigger: "workflows.panel.trigger",
  validation: "workflows.panel.validation",
  variant: "workflows.unit.state",
  event: "workflows.panel.event",
  route: "workflows.panel.route",
  payload: "workflows.panel.carries",
  idempotency: "workflows.panel.doneOnce",
  values: "workflows.panel.values",
  mapsTo: "workflows.panel.mapsTo",
  channel: "workflows.panel.channel",
  condition: "workflows.panel.condition",
  action: "workflows.panel.action",
  mapping: "workflows.panel.dataPassed",
  onFailure: "workflows.panel.onFailure",
  reevaluates: "workflows.panel.reevaluates",
  protocol: "workflows.panel.over",
};

type Condition = { when: string; result: string };

/** One entry per line, held as typed so a new line can be started; the entries go up as they are. */
function ListValue({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <Textarea
      rows={Math.min(Math.max(value.length + 1, 2), 6)}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(linesOf(e.target.value));
      }}
    />
  );
}

/** The rule table: each row a condition and the result it gives. */
function ConditionsValue({ value, onChange }: { value: Condition[]; onChange: (v: Condition[]) => void }) {
  const t = useCopy();
  const keys = useListKeys(value.length);
  const set = (i: number, patch: Partial<Condition>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="grid gap-1.5">
      {value.map((c, i) => (
        <div key={keys.keys[i]} className="flex flex-wrap items-center gap-1.5" data-testid="condition-row">
          <Input className="min-w-32 flex-1" aria-label={t("workflows.panel.if")} placeholder={t("workflows.panel.if")} value={c.when} onChange={(e) => set(i, { when: e.target.value })} />
          <Input className="min-w-32 flex-1" aria-label={t("workflows.panel.then")} placeholder={t("workflows.panel.then")} value={c.result} onChange={(e) => set(i, { result: e.target.value })} />
          <IconButton icon="x" size="sm" aria-label={t("workflows.edit.removeRule", { n: i + 1 })} onClick={() => {
              keys.removed(i);
              onChange(value.filter((_, j) => j !== i));
            }}
          />
        </div>
      ))}
      <Button type="button" size="sm" variant="ghost" icon="plus" className="w-fit" onClick={() => {
          keys.added();
          onChange([...value, { when: "", result: "" }]);
        }}
      >
        {t("workflows.edit.addRule")}
      </Button>
    </div>
  );
}

export function DesignField({
  field,
  value,
  onChange,
  personas,
  error,
  required = true,
}: {
  field: string;
  value: unknown;
  /** `undefined` takes the field away. */
  onChange: (v: unknown) => void;
  /** The personas a screen may be for, where the design declares them. */
  personas: { id: string; label: string }[];
  error: string | undefined;
  /** Owed by the step's type or the line's kind; an optional field is offered unmarked. */
  required?: boolean;
}) {
  const t = useCopy();
  const key = FIELD_LABEL[field];
  const label = key ? t(key) : field;
  const shape = shapeOf(field);
  if (shape === "kept") {
    return (
      <Field label={label} error={error}>
        <span className="text-13 text-muted" data-testid="field-kept" data-field={field}>
          {value === undefined ? t("workflows.edit.owedByAgent") : t("workflows.edit.keptAsDrawn")}
        </span>
      </Field>
    );
  }
  let control: React.ReactNode;
  if (shape === "list") control = <ListValue value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
  else if (shape === "conditions") control = <ConditionsValue value={Array.isArray(value) ? (value as Condition[]) : []} onChange={(rows) => onChange(rows.length ? rows : undefined)} />;
  else if (shape === "variant") control = <Select options={UI_VARIANTS.map((v) => ({ value: v, label: v }))} value={typeof value === "string" ? value : ""} onChange={onChange} placeholder={label} />;
  else if (shape === "persona") control = <Select options={personas.map((p) => ({ value: p.id, label: p.label }))} value={typeof value === "string" ? value : ""} onChange={onChange} placeholder={label} />;
  else control = <Input value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  return (
    <Field label={label} required={required} error={error}>
      {control}
    </Field>
  );
}
