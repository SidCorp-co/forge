import {
  PROJECT_STATUS_DAYS_DEFAULT,
  PROJECT_STATUS_DAYS_MAX,
} from '@forge/contracts/project-status';
import {
  reportDocumentMarkdown,
  type StatusReportRefusalCode,
} from '@forge/contracts/status-reports';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess, type ProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { markStatusReportRead } from '../notifications/index.js';
import { holds, requireHeld } from '../permissions/index.js';
import { statusReportsPorts } from './ports.js';
import {
  deleteStatusReport,
  listStatusReports,
  readStatusReport,
  reportMeta,
  reportRow,
  storeStatusReport,
  storeTemplateReport,
} from './store.js';

const projectParam = z.strictObject({ id: z.uuid() });
const reportParam = z.strictObject({ id: z.uuid(), reportId: z.uuid() });
const saveStatusBody = z.strictObject({
  days: z.number().int().min(1).max(PROJECT_STATUS_DAYS_MAX).optional(),
});
const saveTemplateBody = z.strictObject({
  templateId: z.string().min(1).max(64),
  runIds: z.array(z.string().min(1).max(64)).min(1).max(12),
  narrative: z
    .strictObject({
      summary: z.string().optional(),
      risks: z.string().optional(),
      recommendations: z.string().optional(),
    })
    .default({}),
});
const saveBody = z.union([saveTemplateBody, saveStatusBody]);
const SAVE_SHAPE =
  'invalid body: { days?: 1..90 } saves the project status, or { templateId, runIds: [<run of each template query, in order>], narrative?: { summary?, risks?, recommendations? } } saves a template run';

const agencyOf = (agency: AuthVars['agency']) => {
  if (!agency)
    throw new Error('status reports: a request reached its handler without an auth gate');
  return agency;
};

const refuse = refuser<StatusReportRefusalCode>('STATUS_REPORT_REFUSED');

/**
 * Who may remove a kept report: a project admin, or the person who saved it. A report a schedule
 * sent reached its recipients, so it is an admin's to remove, never its recipients'.
 */
function requireMayDelete(
  access: ProjectAccess,
  userId: string,
  row: NonNullable<Awaited<ReturnType<typeof reportRow>>>,
): void {
  if (holds(access, 'project.admin')) return;
  if (row.producerKind === 'person' && row.producedBy === userId) return;
  throw refuse(
    'STATUS_REPORT_DELETE_FORBIDDEN',
    row.producerKind === 'person'
      ? `status report ${row.id} is removed only by the person who saved it or a project admin (project.admin on ${row.projectId}); the caller is neither`
      : `status report ${row.id} was sent by a schedule to its recipients, so only a project admin (project.admin on ${row.projectId}) removes it; the caller is not one`,
  );
}

export const statusReportRoutes = new Hono<{ Variables: AuthVars }>();
statusReportRoutes.use('/:id/status/reports', requireAuth(), assertEmailVerified());
statusReportRoutes.use('/:id/status/reports/*', requireAuth(), assertEmailVerified());

statusReportRoutes.get(
  '/:id/status/reports',
  zValidator(
    'param',
    projectParam,
    invalid('invalid path: /api/projects/<project>/status/reports'),
  ),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    return c.json({ reports: await listStatusReports(projectId) });
  },
);

statusReportRoutes.post(
  '/:id/status/reports',
  zValidator(
    'param',
    projectParam,
    invalid('invalid path: /api/projects/<project>/status/reports'),
  ),
  zValidator('json', saveBody, invalid(SAVE_SHAPE)),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.write', 'saving a status report');
    const agency = agencyOf(c.get('agency'));
    const body = c.req.valid('json');
    if ('templateId' in body) {
      // the narrative is judged against the template's own runs, read back as the saver, before it is kept
      const document = await statusReportsPorts().checkTemplateNarrative({
        projectId,
        templateId: body.templateId,
        runIds: body.runIds,
        narrative: body.narrative,
        userId,
        agency,
      });
      const row = await storeTemplateReport({
        projectId,
        document,
        producer: { kind: 'person', userId },
      });
      return c.json(await reportMeta(row), 201);
    }
    const row = await storeStatusReport({
      projectId,
      access,
      agency,
      days: body.days ?? PROJECT_STATUS_DAYS_DEFAULT,
      producer: { kind: 'person', userId },
    });
    return c.json(await reportMeta(row), 201);
  },
);

statusReportRoutes.get(
  '/:id/status/reports/:reportId',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>'),
  ),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    const row = await reportRow(projectId, reportId);
    if (!row) throw notFound(`status report ${reportId} is not one of this project's reports`);
    const detail = await readStatusReport(row);
    return c.json(
      await egressForRequest(
        agencyOf(c.get('agency')),
        projectId,
        'issue',
        detail,
        'a stored status report',
      ),
    );
  },
);

/** A stored template report as Markdown: the narrative as kept, then each block's plain text. */
statusReportRoutes.get(
  '/:id/status/reports/:reportId/export',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>/export'),
  ),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    requireHeld(await loadProjectAccess(projectId, c.get('userId')), 'project.read');
    const row = await reportRow(projectId, reportId);
    if (!row) throw notFound(`status report ${reportId} is not one of this project's reports`);
    const detail = await readStatusReport(row);
    if (!detail.document) {
      throw refuse(
        'STATUS_REPORT_REFUSED',
        `status report ${reportId} is a project status read, which the page copies as Markdown; only a template report is exported here`,
        '/reportId',
      );
    }
    const safe = await egressForRequest(
      agencyOf(c.get('agency')),
      projectId,
      'issue',
      detail,
      'a stored template report',
    );
    return c.body(
      reportDocumentMarkdown(safe.document ?? detail.document, {
        title: detail.report.template?.title ?? detail.document.templateId,
        asOf: detail.report.asOf,
      }),
      200,
      { 'content-type': 'text/markdown; charset=utf-8' },
    );
  },
);

statusReportRoutes.post(
  '/:id/status/reports/:reportId/read',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>/read'),
  ),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    const userId = c.get('userId');
    requireHeld(await loadProjectAccess(projectId, userId), 'project.read');
    if (!(await reportRow(projectId, reportId))) {
      throw notFound(`status report ${reportId} is not one of this project's reports`);
    }
    return c.json({ read: await markStatusReportRead(userId, reportId) });
  },
);

statusReportRoutes.delete(
  '/:id/status/reports/:reportId',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>'),
  ),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');
    const row = await reportRow(projectId, reportId);
    if (!row) throw notFound(`status report ${reportId} is not one of this project's reports`);
    requireMayDelete(access, userId, row);
    await deleteStatusReport(row);
    return c.json({ deleted: row.id });
  },
);
