// One period of a `status_report` schedule: store the report it answers (once per schedule and
// period) and tell each recipient once, in their language, linking to the stored report. A schedule
// that names a template runs it for the schedule's owner through the one template run every door
// shares (`reports/templates.ts:runTemplate`, whose one model call writes the narrative from those
// runs alone) and stores the output with how the narrative came to be; a narrative not written is
// named in the notice with the reason. A period whose every recipient is
// already told is refused by name and tells nobody; one stored but not yet told to everyone (a
// recipient added since, a send cut short) tells only those it still owes.

import { statusReportNoticeKey } from '@forge/contracts/notifications';
import { PROJECT_STATUS_DAYS_DEFAULT, type ProjectStatus } from '@forge/contracts/project-status';
import type { ReportDocument } from '@forge/contracts/report-templates';
import {
  narrativeOutcomeLine,
  type StatusReportNarrative,
  statusReportDiff,
  templateTitleOf,
  unwrittenNarrativeLine,
} from '@forge/contracts/status-reports';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, users } from '../db/schema.js';
import { reporterLanguagesOf } from '../feedback/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { counted } from '../lib/plural.js';
import { refuser } from '../lib/refusal.js';
import { emitNotification } from '../notifications/index.js';
import type { StatusReportSendOutcome } from '../schedules/index.js';
import { digestText } from './digest.js';
import { statusReportsPorts } from './ports.js';
import { previousReport, reportOfPeriod, storeStatusReport, storeTemplateReport } from './store.js';

const refuse = refuser<'SCHEDULE_REFUSED'>('SCHEDULE_REFUSED');

export async function sendStatusReport(args: {
  projectId: string;
  scheduleId: string;
  viewerUserId: string;
  recipients: string[];
  days: number | undefined;
  template?: { id: string; params: Record<string, string | number | boolean> | undefined };
  period: Date;
  timeZone: string | null;
  fireId: string;
}): Promise<StatusReportSendOutcome> {
  const periodKey = args.period.toISOString();
  const keys = new Map(
    args.recipients.map((id) => [statusReportNoticeKey(args.scheduleId, periodKey, id), id]),
  );
  let report = await reportOfPeriod(args.scheduleId, args.period);
  let owed = args.recipients;
  if (report) {
    const told = await db
      .select({ key: notifications.dedupeKey })
      .from(notifications)
      .where(inArray(notifications.dedupeKey, [...keys.keys()]));
    const toldIds = new Set(told.map((t) => keys.get(t.key ?? '')));
    owed = args.recipients.filter((id) => !toldIds.has(id));
    if (owed.length === 0) {
      return {
        status: 'refused',
        code: 'STATUS_REPORT_PERIOD_DELIVERED',
        detail: `the period ${periodKey} of this schedule is already delivered: report ${report.id} told every one of its ${counted(args.recipients.length, 'recipient')}, and a period is told once`,
      };
    }
  } else {
    const access = await loadProjectAccess(args.projectId, args.viewerUserId);
    if (!access.role) {
      throw refuse(
        'SCHEDULE_REFUSED',
        `the schedule reads the status as its owner ${args.viewerUserId}, who is no longer a member of the project; an admin saves the schedule again`,
        '/ownerId',
      );
    }
    const [owner] = await db
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, args.viewerUserId))
      .limit(1);
    const agency = owner?.kind ?? 'human';
    const producer = {
      kind: 'schedule',
      userId: args.viewerUserId,
      scheduleId: args.scheduleId,
      period: args.period,
    } as const;
    try {
      if (args.template) {
        const { document, narrative } = await statusReportsPorts().runTemplate({
          projectId: args.projectId,
          templateId: args.template.id,
          params: args.template.params,
          asker: { userId: args.viewerUserId, agency, access },
          what: `schedule ${args.scheduleId}'s ${args.template.id} report`,
        });
        report = await storeTemplateReport({
          projectId: args.projectId,
          document,
          producer,
          narrative,
        });
      } else {
        report = await storeStatusReport({
          projectId: args.projectId,
          access,
          agency,
          days: args.days ?? PROJECT_STATUS_DAYS_DEFAULT,
          producer,
        });
      }
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return sendStatusReport(args);
    }
  }
  const document = report.document as ReportDocument | null;
  const status = report.report as ProjectStatus | null;
  const prev = status ? await previousReport(report) : null;
  const diff =
    status && prev
      ? {
          previousAsOf: prev.asOf.toISOString(),
          diff: statusReportDiff(prev.report as ProjectStatus, status),
        }
      : null;
  const narrative = report.narrativeOutcome as StatusReportNarrative | null;
  const templateNotice = document ? templateNoticeText(document, narrative, args.timeZone) : null;
  const languages = await reporterLanguagesOf(owed, args.projectId);
  let told = 0;
  for (const userId of owed) {
    const text =
      templateNotice ??
      digestText(status as ProjectStatus, diff, languages.get(userId) ?? 'en', args.timeZone);
    const { delivered } = await emitNotification({
      recipients: [userId],
      projectId: args.projectId,
      type: 'status_report',
      ...text,
      scheduleRunId: args.fireId,
      statusReportId: report.id,
      dedupeKey: statusReportNoticeKey(args.scheduleId, periodKey, userId),
    });
    told += delivered;
  }
  return {
    status: 'success',
    reportId: report.id,
    told,
    output: `stored report ${report.id} for ${periodKey} and told ${counted(told, 'recipient')}${narrative ? `; narrative ${narrativeLine(narrative)}` : ''}`,
  };
}

const narrativeLine = (n: StatusReportNarrative): string =>
  n.path === 'not_written' ? `not written: ${n.reason}` : n.path;

/**
 * The notice of a template report: what it is and when its figures were read, the summary the model
 * wrote, and which narrative slots are empty and why (a fire whose narrative was not written names
 * the reason). English only; the report itself holds the figures.
 */
function templateNoticeText(
  document: ReportDocument,
  narrative: StatusReportNarrative | null,
  timeZone: string | null,
): { title: string; body: string } {
  const read = Math.max(...document.runs.map((r) => Date.parse(r.asOf)));
  const day = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeZone: timeZone ?? 'UTC',
  }).format(new Date(read));
  const title = templateTitleOf(document.templateId);
  const summary = document.narrative.summary?.trim();
  // the same lines the saved report's page and its Markdown export read
  const empty =
    narrative?.path === 'not_written'
      ? narrativeOutcomeLine(narrative)
      : unwrittenNarrativeLine(document, narrative);
  return {
    title: `${title} report, ${day}`,
    body: [
      `${counted(document.blocks.length, 'block')} drawn from ${counted(document.runs.length, 'query run')}, read ${day}.`,
      summary || null,
      empty,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
