"use client";

// Sending the status report on a schedule: a person picks what is sent (the project status, or one
// of the build's report templates with its params), the day, the time and the recipients among
// the project members; the browser's zone is the one the time is read in. It is an ordinary
// `status_report` schedule (`/api/schedules`), fired by core's one scheduler, so it also shows on
// Automation; core refuses no recipients or a recipient who is not a member, by name.

import { STATUS_REPORT_DEFAULT_CRON } from "@forge/contracts/status-reports";
import { type FormEvent, useMemo, useState } from "react";
import { Button, Checkbox, ConfirmDialog, Field, Input, NativeSelect, ViewHeading } from "@/design";
import { useCreateSchedule, useDeleteSchedule, useRunSchedule, useSchedules, useUpdateSchedule } from "@/features/automation/schedule-hooks";
import type { ScheduleRow } from "@/features/automation/schedule-types";
import { useProjectMembers } from "@/features/issues/hooks";
import { useCopy, useInterfaceLanguage } from "@/lib/i18n/interface-language";
import { useReportTemplates } from "../hooks";
import { TemplateParamFields, type TemplateParamValues, TemplatePicker, templateParamsOf } from "./template-params";

const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;

/** The day and time of a weekly cron (`m h * * d`), or null for any other shape. */
export function weeklyOf(cron: string): { day: number; time: string } | null {
  const m = WEEKLY.exec(cron.trim());
  if (!m) return null;
  return { day: Number(m[3]), time: `${m[2]?.padStart(2, "0")}:${m[1]?.padStart(2, "0")}` };
}

export function weeklyCron(day: number, time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${m ?? 0} ${h ?? 0} * * ${day}`;
}

/** A weekday's name in the reader's language: 2026-10-04 was a Sunday. */
function dayName(day: number, lang: string): string {
  return new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 4 + day)));
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function recipientsOf(row: ScheduleRow): string[] {
  const r = row.params?.recipients;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

/** The template a status_report schedule runs, by its title where the build still lists it; null sends the project status. */
function templateOf(row: ScheduleRow, titles: ReadonlyMap<string, string>): string | null {
  const id = row.params?.templateId;
  return typeof id === "string" ? (titles.get(id) ?? id) : null;
}

const STATUS = "";

function ScheduleLine({ row, projectId, titles }: { row: ScheduleRow; projectId: string; titles: ReadonlyMap<string, string> }) {
  const t = useCopy();
  const template = templateOf(row, titles);
  const lang = useInterfaceLanguage();
  const update = useUpdateSchedule(projectId);
  const remove = useDeleteSchedule(projectId);
  const run = useRunSchedule(projectId);
  const [asking, setAsking] = useState(false);
  const w = weeklyOf(row.cron);
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-subtle py-2 text-13" data-testid="status-schedule-row">
      <span className="min-w-0 flex-1">
        {w
          ? t("status.schedule.line", { day: dayName(w.day, lang), time: w.time, zone: row.timeZone ?? "UTC", n: recipientsOf(row).length })
          : `${row.cron} (${row.timeZone ?? "UTC"})`}
        <span className="text-muted"> · {template ?? t("status.schedule.projectStatus")}</span>
        {row.enabled ? null : <span className="text-muted"> · {t("status.schedule.paused")}</span>}
      </span>
      <Button size="sm" onClick={() => run.mutate(row.id)} disabled={run.isPending}>
        {t("status.schedule.sendNow")}
      </Button>
      <Button size="sm" onClick={() => update.mutate({ id: row.id, patch: { enabled: !row.enabled } })} disabled={update.isPending}>
        {row.enabled ? t("status.schedule.pause") : t("status.schedule.resume")}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setAsking(true)} disabled={remove.isPending}>
        {t("status.schedule.delete")}
      </Button>
      <ConfirmDialog
        open={asking}
        tone="danger"
        title={t("status.schedule.deleteTitle")}
        message={t("status.schedule.deleteMessage")}
        confirmLabel={t("status.schedule.deleteConfirm")}
        loading={remove.isPending}
        onConfirm={() => remove.mutate(row.id, { onSettled: () => setAsking(false) })}
        onClose={() => setAsking(false)}
      />
    </li>
  );
}

function NewSchedule({ projectId }: { projectId: string }) {
  const t = useCopy();
  const lang = useInterfaceLanguage();
  const members = useProjectMembers(projectId);
  const templates = useReportTemplates(projectId);
  const create = useCreateSchedule(projectId);
  const [templateId, setTemplateId] = useState(STATUS);
  const [values, setValues] = useState<TemplateParamValues>({});
  const template = (templates.data?.templates ?? []).find((x) => x.id === templateId);
  const initial = weeklyOf(STATUS_REPORT_DEFAULT_CRON) ?? { day: 1, time: "09:00" };
  const [day, setDay] = useState(initial.day);
  const [time, setTime] = useState(initial.time);
  const [recipients, setRecipients] = useState<string[]>([]);
  const zone = useMemo(browserZone, []);
  const toggle = (id: string, on: boolean) => setRecipients((r) => (on ? [...r, id] : r.filter((x) => x !== id)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const templateParams = template ? templateParamsOf(template.id, values) : {};
    create.mutate({
      name: template ? t("status.schedule.templateName", { title: template.title }) : t("status.schedule.name"),
      cron: weeklyCron(day, time),
      kind: "status_report",
      timeZone: zone,
      params: template
        ? { recipients, templateId: template.id, ...(Object.keys(templateParams).length ? { templateParams } : {}) }
        : { recipients },
    });
  };
  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-4" data-testid="status-schedule-form">
      <TemplatePicker
        id="status-schedule-report"
        label={t("status.schedule.report")}
        templates={templates.data?.templates ?? []}
        value={templateId}
        onChange={(next) => {
          setTemplateId(next);
          setValues({});
        }}
        extra={[{ value: STATUS, label: t("status.schedule.projectStatus") }]}
      />
      {template ? <TemplateParamFields template={template} values={values} onChange={setValues} idPrefix="status-schedule-param" /> : null}
      <div className="flex flex-wrap gap-4">
        <Field label={t("status.schedule.day")} htmlFor="status-schedule-day">
          <NativeSelect
            id="status-schedule-day"
            value={String(day)}
            onChange={(e) => setDay(Number(e.target.value))}
            options={DAYS.map((d) => ({ value: String(d), label: dayName(d, lang) }))}
          />
        </Field>
        <Field label={t("status.schedule.time")} htmlFor="status-schedule-time" hint={t("status.schedule.zone", { zone })}>
          <Input id="status-schedule-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
        </Field>
      </div>
      <Field label={t("status.schedule.recipients")} hint={t("status.schedule.recipientsHint")}>
        <ul className="grid gap-1.5">
          {(members.data ?? []).map((m) => (
            <li key={m.userId}>
              <Checkbox checked={recipients.includes(m.userId)} onChange={(on) => toggle(m.userId, on)} label={m.displayName ?? m.email} />
            </li>
          ))}
        </ul>
      </Field>
      <span>
        <Button type="submit" variant="primary" size="sm" disabled={create.isPending}>
          {t("status.schedule.create")}
        </Button>
      </span>
    </form>
  );
}

export function ReportSchedule({ projectId }: { projectId: string }) {
  const t = useCopy();
  const schedules = useSchedules(projectId);
  const templates = useReportTemplates(projectId);
  const titles = new Map((templates.data?.templates ?? []).map((x) => [x.id, x.title]));
  const rows = (schedules.data ?? []).filter((s) => s.kind === "status_report");
  return (
    <section aria-label={t("status.schedule.title")} data-testid="status-schedule" className="grid gap-3">
      <ViewHeading>{t("status.schedule.title")}</ViewHeading>
      {rows.length === 0 ? (
        <p className="text-13 text-muted">{t("status.schedule.none")}</p>
      ) : (
        <ul className="border-t border-line-subtle">
          {rows.map((r) => (
            <ScheduleLine key={r.id} row={r} projectId={projectId} titles={titles} />
          ))}
        </ul>
      )}
      <NewSchedule projectId={projectId} />
    </section>
  );
}
