// cm:why the MCP door to the automation read model (ISS-114): the same read functions REST serves at
// /api/projects/:id/automation/standing, /automation/schedules/:scheduleId, /automation/fires/:fireId and
// /automation/reports/:reportId

import {
  AUTOMATION_FIRES_DEFAULT,
  AUTOMATION_FIRES_MAX,
  type ReportStanding,
} from '@forge/contracts/automation-standing';
import { z } from 'zod';
import {
  automationViewerOf,
  readAutomationStanding,
  readFireDetail,
  readReportDetail,
  readScheduleDetail,
} from '../../automation/read.js';
import { egressDeep, egressOr } from '../../lib/data-egress.js';
import {
  assertPrincipalIsMember,
  type ContextScopedMcpToolFactory,
  type McpContext,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';
import { projectMany, summaryNotice, VIEW_RULE, viewInput } from './projection.js';

const ACTIONS = ['standing', 'schedule', 'fire', 'report'] as const;

const inputSchema = z
  .object({
    action: z.enum(ACTIONS),
    projectId: z.uuid().optional(),
    scheduleId: z.uuid().optional(),
    fireId: z.uuid().optional(),
    reportId: z.uuid().optional(),
    firesLimit: z.number().int().min(1).max(AUTOMATION_FIRES_MAX).optional(),
    view: viewInput,
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const DESCRIPTION =
  `Automation as core derives it (design automation rev 1): schedules, their fires and the agent reports the fires filed. Actions: ${ACTIONS.join(' | ')}. ` +
  'standing: every schedule with state on | off | failing | owner_gone | firing, nextFireAt, owner, streak (trailing failed fires; a no-device skip counts, already-applied does not; failing at scheduleFailStreak, as admin alert A5 reads it) and lastFire; ' +
  `the newest fires (firesLimit, default ${AUTOMATION_FIRES_DEFAULT}; read firesHasMore) with status, why and produced {reports, newReports, proposals, issues, runs, notifications} counted by join; ` +
  'every report at triage new, high severity then oldest, then the newest triaged ones; and the steward proposals of the fires served. ' +
  'Each schedule, fire and report carries attentionGroup and waitingOn {kind you | person | admins | writers | issue | feedback | none, who, act triage_report | fix_schedule | reassign_owner | null, rule}: ' +
  'a report a fire filed goes to its schedule owner first, otherwise to members with write access; a failing schedule to its owner; a schedule whose owner is gone to the admins. ' +
  'schedule: one schedule by scheduleId with its fires, the reports they filed and their proposals. ' +
  'fire: one fire by fireId with each item it produced. report: one agent report by reportId with its fire, triage and whom it waits on. ' +
  `To triage a report: forge_agent_report. ${VIEW_RULE}`;

function need<K extends keyof Input>(input: Input, key: K): NonNullable<Input[K]> {
  const value = input[key];
  if (value === undefined || value === null) {
    throw new Error(`BAD_REQUEST: ${input.action} needs ${String(key)}`);
  }
  return value as NonNullable<Input[K]>;
}

const reportSummary = (r: ReportStanding) => ({
  id: r.id,
  kind: r.kind,
  severity: r.severity,
  target: r.target,
  targetRef: r.targetRef,
  summary: r.summary,
  triage: r.triage,
  fire: r.fire,
  attentionGroup: r.attentionGroup,
  waitingOn: r.waitingOn,
  createdAt: r.createdAt,
});

const FULL = "view: 'full' for each report's detail, suggestion, signal and triage record";

async function run(args: unknown, ctx: McpContext): Promise<unknown> {
  const input = inputSchema.parse(args);
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await assertPrincipalIsMember(ctx.principal, projectId);
  const viewer = await automationViewerOf(projectId, ctx.principal.userId);
  if (!viewer) throw new Error(`FORBIDDEN: not a member of project ${projectId}`);
  const firesLimit = input.firesLimit ?? AUTOMATION_FIRES_DEFAULT;
  switch (input.action) {
    case 'standing': {
      const standing = await readAutomationStanding(projectId, viewer, { firesLimit });
      const read = await egressDeep(projectId, 'issue', standing, 'automation');
      if (!read.ok) return egressOr(read, { projectId });
      return {
        ...read.value,
        reports: projectMany(input.view, read.value.reports, reportSummary),
        ...summaryNotice(input.view, FULL),
      };
    }
    case 'schedule': {
      const scheduleId = need(input, 'scheduleId');
      const detail = await readScheduleDetail(projectId, scheduleId, viewer, { firesLimit });
      if (!detail) {
        throw new Error(`NOT_FOUND: schedule ${scheduleId} is not a schedule of this project`);
      }
      const read = await egressDeep(projectId, 'issue', detail, `schedule ${detail.schedule.name}`);
      if (!read.ok) return egressOr(read, { scheduleId });
      return {
        ...read.value,
        reports: projectMany(input.view, read.value.reports, reportSummary),
        ...summaryNotice(input.view, FULL),
      };
    }
    case 'fire': {
      const fireId = need(input, 'fireId');
      const detail = await readFireDetail(projectId, fireId, viewer);
      if (!detail) {
        throw new Error(`NOT_FOUND: fire ${fireId} is not a fire of a schedule of this project`);
      }
      const read = await egressDeep(projectId, 'issue', detail, `fire ${fireId}`);
      return egressOr(read, { fireId });
    }
    case 'report': {
      const reportId = need(input, 'reportId');
      const detail = await readReportDetail(projectId, reportId, viewer);
      if (!detail) {
        throw new Error(`NOT_FOUND: report ${reportId} is not an agent report of this project`);
      }
      const read = await egressDeep(projectId, 'issue', detail, `report ${reportId}`);
      return egressOr(read, { reportId });
    }
  }
}

export const forgeAutomationTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_automation',
  reach: 'project',
  route: '/api/projects/:id/automation',
  grant: {
    byAction: {
      standing: 'projects:read',
      schedule: 'projects:read',
      fire: 'projects:read',
      report: 'projects:read',
    },
  },
  description: DESCRIPTION,
  inputSchema: zodToMcpSchema(inputSchema),
  handler: (args) => run(args, ctx),
});
