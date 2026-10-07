"use client";

import { Button, Field, Input, Textarea } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import type { SentryConfig, SentryTarget } from "../../types";

/** Editable Sentry target row — strings only so inputs stay controlled. */
export interface TargetRow {
  label: string;
  organizationSlug: string;
  projectSlug: string;
  environment: string;
  notes: string;
}

const FIELDS = ["label", "organizationSlug", "projectSlug", "environment", "notes"] as const;

const emptyRow = (): TargetRow => ({
  label: "",
  organizationSlug: "",
  projectSlug: "",
  environment: "",
  notes: "",
});

/** Seed the editable rows from the stored `targets[]`, else a single blank starter row. */
export function initialTargets(cfg: Partial<SentryConfig>): TargetRow[] {
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) return [emptyRow()];
  return cfg.targets.map((t) => ({
    label: t.label ?? "",
    organizationSlug: t.organizationSlug ?? "",
    projectSlug: t.projectSlug ?? "",
    environment: t.environment ?? "",
    notes: t.notes ?? "",
  }));
}

const hasContent = (t: TargetRow) => FIELDS.some((k) => k !== "label" && t[k].trim());

/** A row carrying any data but no label — must be fixed before save. */
export function rowInvalid(t: TargetRow): boolean {
  return !t.label.trim() && hasContent(t);
}

/** Trimmed targets, blank rows dropped and empty fields omitted. */
export function toTargets(rows: TargetRow[]): SentryTarget[] {
  return rows
    .filter((t) => t.label.trim() || hasContent(t))
    .map((t) => {
      const out: SentryTarget = { label: t.label.trim() };
      for (const k of FIELDS) if (k !== "label" && t[k].trim()) out[k] = t[k].trim();
      return out;
    });
}

/** ISS-526 — repeatable target rows. One shared token reads them all. */
export function SentryTargetsField({
  targets,
  onChange,
  disabled,
}: {
  targets: TargetRow[];
  onChange: (next: TargetRow[]) => void;
  disabled: boolean;
}) {
  const t = useCopy();
  const setTarget = (index: number, key: keyof TargetRow, value: string) =>
    onChange(targets.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const input = (i: number, key: keyof TargetRow, placeholder = t("integrations.sentry.optional")) => (
    <Input
      value={targets[i]?.[key] ?? ""}
      onChange={(e) => setTarget(i, key, e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="fg-label text-muted">{t("integrations.sentry.projects")}</span>
        <Button variant="secondary" icon="plus" onClick={() => onChange([...targets, emptyRow()])} disabled={disabled}>
          {t("integrations.sentry.addProject")}
        </Button>
      </div>
      {targets.length === 0 ? (
        <p className="fg-body-sm text-muted rounded-md border border-dashed border-subtle p-4 text-center">
          {t("integrations.sentry.noProjects")}
        </p>
      ) : (
        targets.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; order is the identity
          <div key={i} className="flex flex-col gap-3 border-t border-line-subtle pt-3">
            <div className="flex items-start justify-between gap-2">
              <span className="fg-label text-muted">{t("integrations.sentry.projectN", { n: i + 1 })}</span>
              <Button
                variant="ghost"
                icon="trash"
                onClick={() => onChange(targets.filter((_, j) => j !== i))}
                disabled={disabled}
                aria-label={t("integrations.sentry.removeProject", { n: i + 1 })}
              />
            </div>
            <Field
              label={t("integrations.provider.label")}
              hint={t("integrations.sentry.labelHint")}
              required
              error={rowInvalid(row) ? t("integrations.sentry.labelRequired") : undefined}
            >
              {input(i, "label", "Backend prod")}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("integrations.sentry.orgSlug")} hint={t("integrations.sentry.orgSlugHint")}>
                {input(i, "organizationSlug")}
              </Field>
              <Field label={t("integrations.sentry.projectSlug")} hint={t("integrations.sentry.projectSlugHint")}>
                {input(i, "projectSlug")}
              </Field>
            </div>
            <Field label={t("integrations.sentry.environment")} hint={t("integrations.sentry.environmentHint")}>
              {input(i, "environment")}
            </Field>
            <Field label={t("integrations.sentry.notes")} hint={t("integrations.sentry.notesHint")}>
              <Textarea
                value={row.notes}
                onChange={(e) => setTarget(i, "notes", e.target.value)}
                rows={2}
                placeholder={t("integrations.sentry.optional")}
                disabled={disabled}
              />
            </Field>
          </div>
        ))
      )}
    </div>
  );
}
