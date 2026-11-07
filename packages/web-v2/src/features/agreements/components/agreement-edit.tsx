// A project admin's change to one agreement (REQ-90 BC-2, design step edit): the rule, the labels or
// categories it applies to, and why, written against the project revision read; and the restore of a
// default, or the retirement of the project's own addition, with its reason. Core's refusal shows on the
// field it names.

import { AGREEMENT_SLUG_MAX, type AgreementCondition, type AgreementView, type AgreementWrite } from "@forge/contracts/agreements";
import { useState } from "react";
import { Button, Field, Input, Textarea, showToast } from "@/design";
import { placeRefusals } from "@/lib/api/field-refusals";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useRestoreAgreement, useWriteAgreement } from "../hooks";
import { listOf } from "../view";

const WRITE_FIELDS = { name: ["/name"], rule: ["/rule"], condition: ["/condition"], reason: ["/reason"] } as const;

function conditionOf(labels: string, categories: string): AgreementCondition | null {
  const l = listOf(labels);
  const c = listOf(categories);
  if (l.length === 0 && c.length === 0) return null;
  return { ...(l.length ? { labels: l } : {}), ...(c.length ? { categories: c } : {}) };
}

/** The write a form sends: `name` only for a new agreement, `condition` null where it always applies. */
export function writeOf(form: { name: string; rule: string; labels: string; categories: string; reason: string }, a: AgreementView | null): AgreementWrite {
  return {
    ...(a ? {} : { name: form.name.trim() }),
    rule: form.rule.trim(),
    condition: conditionOf(form.labels, form.categories),
    reason: form.reason.trim(),
    projectRevision: a?.project?.revision ?? 0,
  };
}

/** A new agreement's slug, from its name: kebab-case, as core reads one. */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, AGREEMENT_SLUG_MAX);

/** `a` null is a new project-only agreement, its slug taken from its name. */
export function AgreementEdit({ projectId, a, onDone }: { projectId: string; a: AgreementView | null; onDone: () => void }) {
  const t = useCopy();
  const write = useWriteAgreement(projectId);
  const c = a?.effective.condition ?? null;
  const [form, setForm] = useState({
    name: "",
    rule: a?.effective.rule ?? "",
    labels: (c?.labels ?? []).join(", "),
    categories: (c?.categories ?? []).join(", "),
    reason: "",
  });
  const refused = placeRefusals(write.error, WRITE_FIELDS);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = () =>
    write.mutate({ slug: a?.slug ?? slugOf(form.name), write: writeOf(form, a) }, {
      onSuccess: () => {
        showToast({ title: t("agreements.saved"), tone: "success" });
        onDone();
      },
    });
  return (
    <form
      className="grid gap-3"
      data-testid="agreement-edit"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {a ? null : (
        <Field label={t("agreements.field.name")} error={refused.at("name")} required>
          <Input value={form.name} onChange={(e) => set("name")(e.target.value)} />
        </Field>
      )}
      <Field label={t("agreements.field.rule")} error={refused.at("rule")} required>
        <Textarea value={form.rule} rows={3} onChange={(e) => set("rule")(e.target.value)} />
      </Field>
      <Field label={t("agreements.field.labels")} error={refused.at("condition")}>
        <Input value={form.labels} onChange={(e) => set("labels")(e.target.value)} />
      </Field>
      <Field label={t("agreements.field.categories")}>
        <Input value={form.categories} onChange={(e) => set("categories")(e.target.value)} />
      </Field>
      <Field label={t("agreements.field.reason")} error={refused.at("reason")} required>
        <Input value={form.reason} onChange={(e) => set("reason")(e.target.value)} />
      </Field>
      <RefusalLine error={write.error} onField={refused.onField} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" loading={write.isPending}>
          {t("agreements.act.save")}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          {t("agreements.act.cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Restores the Forge default over an override, or retires the project's own addition. */
export function AgreementRestore({ projectId, a, onDone }: { projectId: string; a: AgreementView; onDone: () => void }) {
  const t = useCopy();
  const restore = useRestoreAgreement(projectId, a.slug);
  const [reason, setReason] = useState("");
  const refused = placeRefusals(restore.error, { reason: ["/reason"] });
  const addition = a.state === "project_only";
  return (
    <form
      className="grid gap-3"
      data-testid="agreement-restore"
      onSubmit={(e) => {
        e.preventDefault();
        restore.mutate(
          { reason: reason.trim(), projectRevision: a.project?.revision ?? 0 },
          {
            onSuccess: () => {
              showToast({ title: t("agreements.restored"), tone: "success" });
              onDone();
            },
          },
        );
      }}
    >
      <Field label={t("agreements.field.reason")} error={refused.at("reason")} required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <RefusalLine error={restore.error} onField={refused.onField} />
      <div className="flex gap-2">
        <Button type="submit" variant={addition ? "danger" : "primary"} size="sm" loading={restore.isPending}>
          {addition ? t("agreements.act.retireConfirm") : t("agreements.act.restoreConfirm")}
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          {t("agreements.act.cancel")}
        </Button>
      </div>
    </form>
  );
}
