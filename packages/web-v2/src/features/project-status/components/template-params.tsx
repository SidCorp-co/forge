"use client";

// A report template's choice and params, as a person fills them: the templates core lists for this
// build, and each param the chosen one takes, labelled and typed as the shared registry declares it
// (`@forge/contracts/report-template-builtins`). A param left empty is not sent, so core applies the
// template's default or runs the query unfiltered; a value of the wrong type is core's to refuse.

import { builtinReportTemplate } from "@forge/contracts/report-template-builtins";
import { Checkbox, Field, Input, NativeSelect } from "@/design";
import type { TemplateListing } from "../api";

export type TemplateParamValues = Record<string, string | boolean>;
export type TemplateParams = Record<string, string | number | boolean>;

/** The params a template run or schedule sends: only those filled, each as the type the template declares. */
export function templateParamsOf(templateId: string, values: TemplateParamValues): TemplateParams {
  const spec = builtinReportTemplate(templateId)?.params ?? {};
  const out: TemplateParams = {};
  for (const [name, raw] of Object.entries(values)) {
    const type = spec[name]?.type ?? "string";
    if (type === "boolean") {
      if (raw === true) out[name] = true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    out[name] = type === "number" && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  return out;
}

export function TemplatePicker({
  id,
  label,
  templates,
  value,
  onChange,
  extra = [],
}: {
  id: string;
  label: string;
  templates: readonly TemplateListing[];
  value: string;
  onChange: (templateId: string) => void;
  /** Choices listed before the templates (the plain project status, on a schedule). */
  extra?: { value: string; label: string }[];
}) {
  return (
    <Field label={label} htmlFor={id}>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        options={[...extra, ...templates.map((t) => ({ value: t.id, label: t.title }))]}
      />
    </Field>
  );
}

/** One field per param the listed template takes. */
export function TemplateParamFields({
  template,
  values,
  onChange,
  idPrefix,
}: {
  template: TemplateListing;
  values: TemplateParamValues;
  onChange: (next: TemplateParamValues) => void;
  idPrefix: string;
}) {
  const spec = builtinReportTemplate(template.id)?.params ?? {};
  if (template.params.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-4" data-testid="template-params">
      {template.params.map((name) => {
        const p = spec[name];
        const id = `${idPrefix}-${name}`;
        const label = p?.label ?? name;
        if (p?.type === "boolean") {
          return (
            <Checkbox key={name} checked={values[name] === true} onChange={(on) => onChange({ ...values, [name]: on })} label={label} />
          );
        }
        return (
          <Field key={name} label={label} htmlFor={id}>
            <Input
              id={id}
              type={p?.type === "number" ? "number" : "text"}
              value={typeof values[name] === "string" ? (values[name] as string) : ""}
              placeholder={p?.default !== undefined ? String(p.default) : undefined}
              onChange={(e) => onChange({ ...values, [name]: e.target.value })}
            />
          </Field>
        );
      })}
    </div>
  );
}
