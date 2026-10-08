// What a `status_report` schedule's `params` must hold, checked when it is saved and again when it
// fires: at least one recipient, every one a member of the project (any role, org-derived included).
// A recipient who left after the save refuses the fire by name rather than being dropped from it.

import { PROJECT_STATUS_DAYS_MAX } from '@forge/contracts/project-status';
import {
  BUILTIN_REPORT_TEMPLATES,
  builtinReportTemplate,
} from '@forge/contracts/report-template-builtins';
import {
  STATUS_REPORT_PARAMS_SHAPE,
  type StatusReportRefusalCode,
  type StatusReportScheduleParams,
} from '@forge/contracts/status-reports';
import { z } from 'zod';
import { effectiveProjectRole } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';

const refuse = refuser<StatusReportRefusalCode>('STATUS_REPORT_REFUSED');

const paramsSchema = z.strictObject({
  recipients: z.array(z.uuid()).optional(),
  days: z.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
  templateId: z.string().min(1).max(64).optional(),
  templateParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** The params of a `status_report` schedule of `projectId`, or a refusal naming what is wrong. */
export async function statusReportParamsOf(
  projectId: string,
  params: unknown,
): Promise<StatusReportScheduleParams> {
  const parsed = paramsSchema.safeParse(params ?? {});
  if (!parsed.success) {
    throw refuse(
      'STATUS_REPORT_REFUSED',
      `a status_report schedule's params are ${STATUS_REPORT_PARAMS_SHAPE}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '/'} ${i.message}`).join('; ')}`,
      '/params',
    );
  }
  const { templateId, templateParams } = parsed.data;
  if (templateId === undefined && templateParams !== undefined) {
    throw refuse(
      'STATUS_REPORT_REFUSED',
      'templateParams are the params of a report template, and this schedule names no templateId',
      '/params/templateParams',
    );
  }
  if (templateId !== undefined) {
    const template = builtinReportTemplate(templateId);
    if (!template) {
      throw refuse(
        'STATUS_REPORT_REFUSED',
        `no report template "${templateId}"; templates: ${BUILTIN_REPORT_TEMPLATES.map((t) => t.id).join(', ')}`,
        '/params/templateId',
      );
    }
    if (parsed.data.days !== undefined) {
      throw refuse(
        'STATUS_REPORT_REFUSED',
        `a schedule that runs template "${templateId}" takes its window from the template's params (${Object.keys(template.params).join(', ') || 'none'}), not days`,
        '/params/days',
      );
    }
    const unknown = Object.keys(templateParams ?? {}).filter(
      (n) => !Object.hasOwn(template.params, n),
    );
    if (unknown.length > 0) {
      throw refuse(
        'STATUS_REPORT_REFUSED',
        `template "${templateId}" takes no param ${unknown.map((n) => `"${n}"`).join(', ')}; it takes: ${Object.keys(template.params).join(', ') || '(none)'}`,
        '/params/templateParams',
      );
    }
  }
  const recipients = [...new Set(parsed.data.recipients ?? [])];
  if (recipients.length === 0) {
    throw refuse(
      'STATUS_REPORT_NO_RECIPIENTS',
      'a status_report schedule names at least one recipient among the project members, and this one names none',
      '/params/recipients',
    );
  }
  const roles = await Promise.all(recipients.map((id) => effectiveProjectRole(id, projectId)));
  const outsiders = recipients.filter((_, at) => !roles[at]?.role);
  if (outsiders.length > 0) {
    throw refuse(
      'STATUS_REPORT_RECIPIENT_NOT_MEMBER',
      `a status report goes only to members of the project, and ${outsiders.join(', ')} ${outsiders.length === 1 ? 'is' : 'are'} not one`,
      '/params/recipients',
    );
  }
  return {
    recipients,
    ...(parsed.data.days ? { days: parsed.data.days } : {}),
    ...(templateId ? { templateId } : {}),
    ...(templateId && templateParams ? { templateParams } : {}),
  };
}
