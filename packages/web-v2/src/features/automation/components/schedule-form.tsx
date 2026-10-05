"use client";

import { type FormEvent, useState } from "react";
import { Button, Field, Input, NativeSelect, Textarea } from "@/design";
import type { ScheduleInput, ScheduleKind, ScheduleRow } from "@/features/schedules/types";
import { formatRefusal } from "@/lib/api/error";

const KIND_OPTIONS: { value: ScheduleKind; label: string }[] = [
  { value: "prompt", label: "Prompt" },
  { value: "script", label: "Script" },
  { value: "release_batch", label: "Release batch" },
  { value: "sentry_pull", label: "Sentry pull" },
];

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
      <Field label="Name" htmlFor={`${testId}-name`} required>
        <Input id={`${testId}-name`} value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </Field>
      <Field label="When" htmlFor={`${testId}-cron`} hint="A cron expression, for example 0 9 * * 1-5" required>
        <Input id={`${testId}-cron`} className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} required />
      </Field>
      <Field label="Kind" htmlFor={`${testId}-kind`}>
        <NativeSelect
          id={`${testId}-kind`}
          options={KIND_OPTIONS}
          value={kind}
          disabled={!!initial}
          onChange={(e) => setKind(e.target.value as ScheduleKind)}
        />
      </Field>
      {carriesBody ? (
        <Field label={kind === "script" ? "Script" : "Prompt"} htmlFor={`${testId}-body`} required>
          <Textarea id={`${testId}-body`} rows={8} value={body} onChange={(e) => setBody(e.target.value)} required />
        </Field>
      ) : null}
      <Field label="Target project" htmlFor={`${testId}-target`} hint="A project slug; empty runs it on this project">
        <Input id={`${testId}-target`} value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
      <span className="inline-flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={pending}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {error ? <span className="text-12-5 text-danger">{formatRefusal(error)}</span> : null}
      </span>
    </form>
  );
}
