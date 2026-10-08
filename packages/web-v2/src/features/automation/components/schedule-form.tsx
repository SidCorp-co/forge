"use client";

import { type FormEvent, useState } from "react";
import { Button, Field, Input, NativeSelect, Textarea } from "@/design";
import { enumLabel } from "@/design/vocabulary";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import type { ScheduleInput, ScheduleKind, ScheduleRow } from "@/features/automation/schedule-types";
import { formatRefusal } from "@/lib/api/error";

const KINDS: ScheduleKind[] = ["prompt", "script", "release_batch", "sentry_pull"];

/** One form for a new schedule and for editing one; the server refuses a bad cron or target by name. */
export function ScheduleForm({
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  testId,
}: {
  initial?: ScheduleRow;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (input: ScheduleInput) => void;
  onCancel: () => void;
  testId: string;
}) {
  const t = useCopy();
  const language = useInterfaceLanguage();
  // a status report is set up on the project's status page, where its recipients are picked
  const kinds = initial && !KINDS.includes(initial.kind) ? [...KINDS, initial.kind] : KINDS;
  const kindOptions = kinds.map((k) => ({ value: k, label: enumLabel("scheduleKind", k, language) }));
  const [name, setName] = useState(initial?.name ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "");
  const [kind, setKind] = useState<ScheduleKind>(initial?.kind ?? "prompt");
  const [body, setBody] = useState((initial?.kind === "script" ? initial.script : initial?.prompt) ?? "");
  const [target, setTarget] = useState(initial?.targetProjectSlug ?? "");
  const carriesBody = kind === "prompt" || kind === "script";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      cron: cron.trim(),
      kind,
      ...(kind === "prompt" ? { prompt: body } : {}),
      ...(kind === "script" ? { script: body } : {}),
      targetProjectSlug: target.trim() || null,
    });
  };

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" data-testid={testId}>
      <Field label={t("schedules.form.name")} htmlFor={`${testId}-name`} required>
        <Input id={`${testId}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </Field>
      <Field label={t("schedules.form.when")} htmlFor={`${testId}-cron`} hint={t("schedules.form.whenHint")} required>
        <Input id={`${testId}-cron`} className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} required />
      </Field>
      <Field label={t("schedules.form.kind")} htmlFor={`${testId}-kind`}>
        <NativeSelect
          id={`${testId}-kind`}
          options={kindOptions}
          value={kind}
          disabled={!!initial}
          onChange={(e) => setKind(e.target.value as ScheduleKind)}
        />
      </Field>
      {carriesBody ? (
        <Field label={kind === "script" ? t("schedules.script") : t("schedules.prompt")} htmlFor={`${testId}-body`} required>
          <Textarea id={`${testId}-body`} rows={8} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
      ) : null}
      <Field label={t("schedules.form.target")} htmlFor={`${testId}-target`} hint={t("schedules.form.targetHint")}>
        <Input id={`${testId}-target`} value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
      <span className="inline-flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("schedules.form.cancel")}
        </Button>
        {error ? <span className="text-12-5 text-danger">{formatRefusal(error)}</span> : null}
      </span>
    </form>
  );
}
