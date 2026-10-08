// REQ-34 BC-3, BC-18 — the form of a checklist a move was refused by, built from the one definition
// the kernel judges it with (`@forge/contracts/checklists:checklistFormOf`). Each refusal is shown
// on the field its path names; a field the issue's own record answers is shown, not typed.

"use client";

import { CHECKLISTS, isChecklistId } from "@forge/contracts/checklist-registry";
import { type ChecklistFormField, checklistFormOf } from "@forge/contracts/checklists";
import type { Refusal } from "@forge/contracts/refusal";
import { useEffect, useState } from "react";
import { Button, Field, Radio, RadioGroup, Textarea } from "@/design";
import { SlideOver } from "@/design/patterns/slide-over";
import { useCopy } from "@/lib/i18n/interface-language";

export interface ChecklistPrompt {
  /** The checklist the refusals name. */
  checklist: string;
  refusals: Refusal[];
}

export interface ChecklistField extends ChecklistFormField {
  /** The plain-words refusal on this field, or null. */
  error: string | null;
}

/** The checklist's fields in its order, each carrying the refusal its path names. */
export function checklistFieldsOf(prompt: ChecklistPrompt): { title: string; fields: ChecklistField[] } | null {
  if (!isChecklistId(prompt.checklist)) return null;
  const form = checklistFormOf(CHECKLISTS[prompt.checklist]);
  return {
    title: form.title,
    fields: form.fields.map((f) => ({
      ...f,
      error: prompt.refusals.find((r) => r.path === f.path)?.detail ?? null,
    })),
  };
}

/** The checklist a refused move names, read off its leading refusal row. */
export function checklistPromptOf(refusals: Refusal[]): ChecklistPrompt | null {
  const named = refusals.find(
    (r) => typeof (r as { checklist?: unknown }).checklist === "string",
  ) as (Refusal & { checklist: string }) | undefined;
  return named ? { checklist: named.checklist, refusals } : null;
}

interface ChecklistDialogProps {
  prompt: ChecklistPrompt | null;
  loading: boolean;
  onConfirm: (answers: Record<string, string>) => void;
  onClose: () => void;
}

export function ChecklistDialog({ prompt, loading, onConfirm, onClose }: ChecklistDialogProps) {
  const t = useCopy();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (prompt) setAnswers({});
  }, [prompt]);
  if (!prompt) return null;
  const read = checklistFieldsOf(prompt);
  if (!read) return null;
  const set = (name: string, value: string) => setAnswers((a) => ({ ...a, [name]: value }));
  const given = Object.fromEntries(
    Object.entries(answers)
      .map(([k, v]) => [k, v.trim()] as const)
      .filter(([, v]) => v !== ""),
  );
  const unrecognised = prompt.refusals.filter((r) => !read.fields.some((f) => f.path === r.path));

  return (
    <SlideOver open onClose={onClose} title={t("issues.checklist.title", { name: read.title })} width={520}>
      <div className="flex h-full flex-col gap-4">
        <p className="fg-body-sm text-muted">{t("issues.checklist.blurb")}</p>
        {unrecognised.map((r) => (
          <p key={`${r.code}${r.path}`} role="alert" className="fg-body-sm" style={{ color: "var(--red-600)" }}>
            {r.detail}
          </p>
        ))}
        {read.fields.map((f) => (
          <ChecklistInput key={f.name} field={f} value={answers[f.name] ?? ""} onChange={(v) => set(f.name, v)} />
        ))}
        <div className="mt-auto flex items-center justify-end gap-2.5 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading}>
            {t("common.cancel")}
          </Button>
          <Button type="button" variant="primary" loading={loading} onClick={() => onConfirm(given)}>
            {t("issues.checklist.confirm")}
          </Button>
        </div>
      </div>
    </SlideOver>
  );
}

function ChecklistInput({
  field,
  value,
  onChange,
}: {
  field: ChecklistField;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useCopy();
  const error = field.error ?? undefined;
  if (field.answeredBy === "record") {
    return (
      <Field label={field.label} error={error} hint={t("issues.checklist.fromRecord", { field: field.recordField ?? "" })}>
        <p className="fg-body-sm text-muted">{field.help}</p>
      </Field>
    );
  }
  const hint = field.recommended ? t("issues.checklist.assumed", { answer: field.recommended }) : undefined;
  if (field.control === "choice") {
    return (
      <Field label={field.label} error={error} hint={hint} required={field.blocking}>
        <RadioGroup name={field.name} value={value} onChange={onChange}>
          {field.options.map((o) => (
            <Radio key={o.value} value={o.value} label={o.label} />
          ))}
        </RadioGroup>
      </Field>
    );
  }
  return (
    <Field label={field.label} error={error} hint={hint} required={field.blocking}>
      <Textarea
        rows={3}
        value={value}
        maxLength={field.maxLength ?? undefined}
        placeholder={field.recommended ?? undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
