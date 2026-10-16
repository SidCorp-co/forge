// One step, and one line, of a design written in place. A step is its name on the card, what happens
// there, its type and band from the template, the steps it comes after, and the fields its type owes.
// A line is where it runs from and to, its kind, its words, and the fields its kind owes. A refusal
// core names under `/steps/<i>` or `/edges/<i>` opens that step or line and is drawn in it.

import type { WorkflowTemplate } from "@forge/contracts/workflow-templates";
import { useState } from "react";
import { ChoiceChips, Disclosure, Field, IconButton, Input, Select, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { titleOf } from "../canvas/model";
import { edgeFieldsOf, type ItemRefusals, lineOptionalOf, nodeFieldsOf, stepOptionalOf, withEdgeField, withNodeField } from "../design-draft";
import type { WorkflowEdgeContract, WorkflowStep } from "../types";
import { DesignField } from "./design-fields";

const ANY = "";

export function StepEditor({
  step,
  n,
  steps,
  template,
  bands,
  personas,
  errors,
  onChange,
  onRemove,
}: {
  step: WorkflowStep;
  n: number;
  /** Every step of the design, for what this one comes after. */
  steps: WorkflowStep[];
  template: WorkflowTemplate | null;
  bands: { id: string; label: string }[];
  personas: { id: string; label: string }[];
  errors: ItemRefusals;
  onChange: (s: WorkflowStep) => void;
  onRemove: () => void;
}) {
  const t = useCopy();
  const [open, setOpen] = useState(false);
  const refused = errors.any;
  const node = step.node;
  const typeLabel = template?.nodeTypes.find((x) => x.id === node?.type)?.label ?? node?.type ?? "";
  const owed = nodeFieldsOf(template, node?.type);
  const optional = stepOptionalOf(owed);
  const others = steps.filter((s) => s.id !== step.id);
  const rest = errors.rest(["node/label", "does", "node/type", "node/band", "after", ...[...owed, ...optional].map((f) => `node/${f}`)]);
  return (
    <li className="border-b border-line-subtle" data-testid="step-draft" data-step={step.id} data-refused={refused || undefined}>
      <Disclosure title={`${n}. ${titleOf(step)}`} summary={typeLabel} open={open || refused} onOpenChange={setOpen}>
        <div className="grid gap-3 pb-4 pl-7 max-md:pl-0">
          {rest ? (
            <p role="alert" className="text-12 text-danger-11">
              {rest}
            </p>
          ) : null}
          <Field label={t("workflows.edit.stepLabel")} required error={errors.at("node/label")}>
            <Input value={node?.label ?? ""} onChange={(e) => onChange(withNodeField(step, "label", e.target.value))} maxLength={60} />
          </Field>
          <Field label={t("workflows.edit.does")} required error={errors.at("does")}>
            <Textarea rows={2} value={step.does} onChange={(e) => onChange({ ...step, does: e.target.value })} maxLength={600} />
          </Field>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("workflows.panel.kind")} error={errors.at("node/type")}>
              <Select options={(template?.nodeTypes ?? []).map((x) => ({ value: x.id, label: x.label }))} value={node?.type ?? ""} onChange={(type) => onChange(withNodeField(step, "type", type))} />
            </Field>
            {bands.length > 0 ? (
              <Field label={t("workflows.panel.stage")} error={errors.at("node/band")}>
                <Select options={[{ value: ANY, label: t("workflows.edit.homeBand") }, ...bands.map((b) => ({ value: b.id, label: b.label }))]} value={node?.band ?? ANY} onChange={(band) => onChange(withNodeField(step, "band", band))} />
              </Field>
            ) : null}
          </div>
          {others.length > 0 ? (
            <Field label={t("workflows.edit.after")} error={errors.at("after")}>
              <ChoiceChips label={t("workflows.edit.after")} multiple options={others.map((s) => ({ value: s.id, label: titleOf(s) }))} value={step.after} onChange={(after) => onChange({ ...step, after })} />
            </Field>
          ) : null}
          {owed.map((field) => (
            <DesignField
              key={field}
              field={field}
              value={(node as Record<string, unknown> | undefined)?.[field]}
              onChange={(v) => onChange(withNodeField(step, field, v))}
              personas={personas}
              error={errors.at(`node/${field}`)}
            />
          ))}
          <div className="grid gap-3 border-t border-line-subtle pt-3 md:grid-cols-2" data-testid="step-optional">
            {optional.map((field) => (
              <DesignField
                key={field}
                field={field}
                required={false}
                value={(node as Record<string, unknown> | undefined)?.[field]}
                onChange={(v) => onChange(withNodeField(step, field, v))}
                personas={personas}
                error={errors.at(`node/${field}`)}
              />
            ))}
          </div>
          <span className="flex justify-end">
            <IconButton icon="trash" size="sm" aria-label={t("workflows.edit.removeStep", { name: titleOf(step) })} onClick={onRemove} />
          </span>
        </div>
      </Disclosure>
    </li>
  );
}

export function LineEditor({
  edge,
  n,
  steps,
  template,
  errors,
  onChange,
  onRemove,
}: {
  edge: WorkflowEdgeContract;
  n: number;
  steps: WorkflowStep[];
  template: WorkflowTemplate | null;
  errors: ItemRefusals;
  onChange: (e: WorkflowEdgeContract) => void;
  onRemove: () => void;
}) {
  const t = useCopy();
  const stepOptions = steps.map((s) => ({ value: s.id, label: titleOf(s) }));
  const owed = edgeFieldsOf(template, edge.kind);
  const optional = lineOptionalOf(owed);
  const rest = errors.rest(["from", "to", "kind", "label", ...owed, ...optional]);
  return (
    <li className="grid gap-2 border-b border-line-subtle py-3" data-testid="line-draft" data-refused={errors.any || undefined}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-12 font-semibold text-muted">{t("workflows.edit.lineN", { n })}</span>
        <span className="flex-1" />
        <IconButton icon="trash" size="sm" aria-label={t("workflows.edit.removeLine", { n })} onClick={onRemove} />
      </div>
      {rest ? (
        <p role="alert" className="text-12 text-danger-11">
          {rest}
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t("workflows.panel.comesFrom")} error={errors.at("from")}>
          <Select options={stepOptions} value={edge.from} onChange={(from) => onChange({ ...edge, from })} />
        </Field>
        <Field label={t("workflows.panel.leadsTo")} error={errors.at("to")}>
          <Select options={stepOptions} value={edge.to} onChange={(to) => onChange({ ...edge, to })} />
        </Field>
        <Field label={t("workflows.panel.kind")} error={errors.at("kind")}>
          <Select
            options={[{ value: ANY, label: t("workflows.edit.kindFromSteps") }, ...(template?.edgeKinds ?? []).map((k) => ({ value: k.id, label: k.label }))]}
            value={edge.kind ?? ANY}
            onChange={(kind) => onChange(withEdgeField(edge, "kind", kind))}
          />
        </Field>
      </div>
      <Field label={t("workflows.edit.lineLabel")} error={errors.at("label")}>
        <Input value={edge.label ?? ""} onChange={(e) => onChange(withEdgeField(edge, "label", e.target.value))} maxLength={60} />
      </Field>
      {owed.map((field) => (
        <DesignField key={field} field={field} value={(edge as unknown as Record<string, unknown>)[field]} onChange={(v) => onChange(withEdgeField(edge, field, v))} personas={[]} error={errors.at(field)} />
      ))}
      <div className="grid gap-3 md:grid-cols-2">
        {optional.map((field) => (
          <DesignField key={field} field={field} required={false} value={(edge as unknown as Record<string, unknown>)[field]} onChange={(v) => onChange(withEdgeField(edge, field, v))} personas={[]} error={errors.at(field)} />
        ))}
      </div>
    </li>
  );
}
