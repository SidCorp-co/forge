import { z } from 'zod';
import { describeOperation, json } from '../api-reference/declare/describe.js';
import { tableRow } from '../api-reference/declare/rows.js';
import { activityLog, devices } from '../db/schema.js';
import { GLANCE_METRIC_NAMES, GLANCE_WINDOWS } from './types.js';

/** What every offset-paged admin list answers with. */
function listOf<S extends z.ZodType>(item: S) {
  return z.object({
    items: z.array(item),
    returned: z.number(),
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
    hasMore: z.boolean(),
  });
}

const nullableNumber = z.number().nullable();

const glanceMetricSchema = z.object({
  value: nullableNumber,
  deltaPct: nullableNumber,
  spark: z.array(z.number()),
});

export const overviewSchema = z.object({
  counts: z.object({
    users: z.number(),
    usersNew: z.number(),
    orgs: z.number(),
    projects: z.number(),
    activeWorkspaces: z.number(),
    devicesOnline: z.number(),
    devicesTotal: z.number(),
  }),
  kpis: z.object({
    openAlerts: z.number(),
    inFlightJobs: z.number(),
    spendWindowUsd: z.number(),
    spendBaselineUsd: z.number(),
  }),
  glance: z.record(z.enum(GLANCE_METRIC_NAMES), glanceMetricSchema),
});

export const adoptionSchema = z.array(
  z.object({
    bucketStart: z.string(),
    newUsers: z.number(),
    cumulativeUsers: z.number(),
    activeWorkspaces: z.number(),
  }),
);

export const workspaceListSchema = listOf(
  z.object({
    projectId: z.string(),
    slug: z.string(),
    runs: z.number(),
    spendUsd: z.number(),
    medianLeadTimeMin: nullableNumber,
    openIssues: z.number(),
  }),
);

export const metricSeriesSchema = z.object({
  metric: z.enum(GLANCE_METRIC_NAMES),
  window: z.enum(GLANCE_WINDOWS),
  value: nullableNumber,
  deltaPct: nullableNumber,
  points: z.array(z.object({ bucketStart: z.string(), value: nullableNumber })),
});

export const alertListSchema = listOf(
  z.object({
    id: z.enum(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']),
    key: z.string(),
    status: z.enum(['ok', 'warn', 'crit']),
    count: z.number(),
    detail: z.string(),
    since: z.string().nullable(),
    entities: z.array(
      z.object({
        ref: z.string(),
        kind: z.enum(['job', 'project', 'runner', 'device', 'schedule', 'integration_binding']),
        label: z.string(),
      }),
    ),
  }),
);

export const thresholdsSchema = z.object({
  stuckJobSeconds: z.number(),
  runnerStarvedSeconds: z.number(),
  spendCeilingUsdDay: nullableNumber,
  spendSpikeMultiple: z.number(),
  scheduleFailStreak: z.number(),
  deliveryFailRatePct: z.number(),
  interventionLabels: z.array(z.string()),
  ghostRunnerOfflineDays: z.number(),
  sentryMinEventCount: z.number(),
  sentryMinUserCount: z.number(),
});

export const mcpAuditSchema = z.object({
  generatedAt: z.string(),
  oldestRow: z.string().nullable(),
  retention: z.object({ days: nullableNumber, why: z.string() }),
  registeredCount: z.number(),
  rows: z.array(
    z.object({
      tool: z.string(),
      registered: z.boolean(),
      deviceCalls: z.number(),
      tokenCalls: z.number(),
      unattributedCalls: z.number(),
      notFoundCalls: z.number(),
      totalCalls: z.number(),
      firstSeen: z.string().nullable(),
      lastSeen: z.string().nullable(),
    }),
  ),
});

export const pipelineHealthSchema = z.object({
  waiting: z.array(
    z.object({
      id: z.string(),
      issSeq: z.number(),
      title: z.string(),
      projectId: z.string(),
      projectSlug: z.string(),
      projectName: z.string(),
      status: z.string(),
      updatedAt: z.date(),
    }),
  ),
  failureBreakdown: z.array(z.object({ kind: z.string(), count: z.number() })),
});

export const retrievalBreakdownSchema = z.object({
  projectId: z.string(),
  since: z.string(),
  strategies: z.array(
    z.object({
      strategy: z.string(),
      searches: z.number(),
      avgHitCount: z.number(),
      semanticHits: z.number(),
      keywordHits: z.number(),
      overlap: z.number(),
    }),
  ),
});

export const adminUserListSchema = listOf(
  z.object({
    id: z.string(),
    email: z.string(),
    emailVerifiedAt: z.date().nullable(),
    createdAt: z.date(),
  }),
);

export const adminProjectListSchema = listOf(
  z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    createdBy: z.string().nullable(),
    creatorEmail: z.string().nullable(),
    memberCount: z.number(),
    createdAt: z.date(),
  }),
);

export const adminDeviceListSchema = listOf(tableRow(devices));
export const auditListSchema = listOf(tableRow(activityLog));

export const whoamiSchema = z.object({ isAdmin: z.boolean(), email: z.string() });

export const readOverview = describeOperation({
  summary: 'The operator glance: platform counts, spend, open alerts and five trend figures',
  responses: { 200: json(overviewSchema, 'Counts, kpis and glance metrics over the window') },
});

export const readAdoption = describeOperation({
  summary: 'New and cumulative users and active workspaces per day or week, oldest first',
  description: 'Dense: a bucket with no rows is present at zero.',
  responses: { 200: json(adoptionSchema, 'One entry per bucket') },
});

export const listWorkspaces = describeOperation({
  summary: 'Active projects ranked by runs, spend or median lead time over a window',
  responses: { 200: json(workspaceListSchema, 'The top projects by the chosen sort') },
});

export const readMetricSeries = describeOperation({
  summary: 'The dense series behind one glance figure',
  responses: { 200: json(metricSeriesSchema, 'The figure, its change and its points') },
});

export const listAlerts = describeOperation({
  summary: 'The six operator alerts with their status and the entities behind each',
  responses: { 200: json(alertListSchema, 'Every alert, ok ones included') },
});

export const showThresholds = describeOperation({
  summary: 'The alert thresholds and spend ceiling in force',
  responses: { 200: json(thresholdsSchema) },
});

export const putThresholds = describeOperation({
  summary: 'Change the alert thresholds named in the body; the rest keep their values',
  responses: { 200: json(thresholdsSchema, 'All thresholds after the change') },
});

export const readMcpAudit = describeOperation({
  summary: 'Lifetime MCP call counts per tool, split by device, token and unattributed callers',
  responses: { 200: json(mcpAuditSchema) },
});

export const readPipelineHealth = describeOperation({
  summary: 'Issues parked at waiting and the last day of job failures by kind',
  responses: { 200: json(pipelineHealthSchema, 'Up to 100 waiting issues, newest first') },
});

export const readRetrievalBreakdown = describeOperation({
  summary: "A project's memory searches by retrieval strategy since a date",
  description: 'The window opens seven days back when `since` is not sent.',
  responses: { 200: json(retrievalBreakdownSchema) },
});

export const listAdminUsers = describeOperation({
  summary: 'Every user, newest first, optionally matched on email',
  responses: { 200: json(adminUserListSchema) },
});

export const listAdminProjects = describeOperation({
  summary: 'Every project with its creator and member count, optionally matched on slug or name',
  responses: { 200: json(adminProjectListSchema) },
});

export const listAdminDevices = describeOperation({
  summary: 'Every device, newest first, optionally by status',
  responses: { 200: json(adminDeviceListSchema) },
});

export const listAudit = describeOperation({
  summary: 'The activity log, newest first, by action, actor or start date',
  responses: { 200: json(auditListSchema) },
});

export const readWhoami = describeOperation({
  summary: 'Whether the caller is a platform administrator',
  responses: { 200: json(whoamiSchema) },
});
