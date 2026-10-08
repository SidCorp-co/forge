import {
  PROJECT_STATUS_DAYS_DEFAULT,
  PROJECT_STATUS_DAYS_MAX,
} from '@forge/contracts/project-status';
import {
  reportDocumentMarkdown,
  type StatusReportRefusalCode,
} from '@forge/contracts/status-reports';
import { tableCsv } from '@forge/contracts/visual-blocks';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess, type ProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { markStatusReportRead } from '../notifications/index.js';
import { holds, requireHeld } from '../permissions/index.js';
import { saveTemplateReport } from './save.js';
import {
  deleteStatusReport,
  listStatusReports,
  readStatusReport,
  reportMeta,
  reportRow,
  storeStatusReport,
} from './store.js';

const projectParam = z.strictObject({ id: z.uuid() });
const reportParam = z.strictObject({ id: z.uuid(), reportId: z.uuid() });
const exportQuery = z.strictObject({
  format: z.enum(['markdown', 'csv']).default('markdown'),
  block: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,2})$/)
    .transform(Number)
    .optional(),
});
const EXPORT_SHAPE =
  'invalid query: ?format=markdown (the default) exports the whole report, ?format=csv&block=<index of a table block, from 0> exports that table';
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
  holdChatWrite('report_save'),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    const agency = agencyOf(c.get('agency'));
    const body = c.req.valid('json');
    if ('templateId' in body) {
      const meta = await saveTemplateReport({
        projectId,
        access,
        userId,
        agency,
        templateId: body.templateId,
        runIds: body.runIds,
        narrative: body.narrative,
      });
      return c.json(meta, 201);
    }
    requireHeld(access, 'project.write', 'saving a status report');
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

/** A download's file name: the template, the day it was read, and the block a CSV holds. */
const exportName = (templateId: string, asOf: string, ext: string, block?: number): string =>
  `${templateId}-${asOf.slice(0, 10)}${block === undefined ? '' : `-block-${block + 1}`}.${ext}`;

/**
 * A stored template report as a file: Markdown (the narrative outcome, the narrative as kept, then
 * each block's plain text), or one table block as CSV. Core alone builds the export; the page
 * downloads what this answers.
 */
statusReportRoutes.get(
  '/:id/status/reports/:reportId/export',
  zValidator(
    'param',
    reportParam,
    invalid('invalid path: /api/projects/<project>/status/reports/<report id>/export'),
  ),
  zValidator('query', exportQuery, invalid(EXPORT_SHAPE)),
  async (c) => {
    const { id: projectId, reportId } = c.req.valid('param');
    const { format, block } = c.req.valid('query');
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
    const document = safe.document ?? detail.document;
    const { templateId } = document;
    if (format === 'markdown') {
      if (block !== undefined) {
        throw refuse(
          'STATUS_REPORT_REFUSED',
          `block=${block} names one table, which only ?format=csv exports; the Markdown export is the whole report`,
          '/block',
        );
      }
      return c.body(
        reportDocumentMarkdown(document, {
          title: detail.report.template?.title ?? templateId,
          asOf: detail.report.asOf,
          narrative: detail.narrative,
        }),
        200,
        {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${exportName(templateId, detail.report.asOf, 'md')}"`,
        },
      );
    }
    const tables = document.blocks.flatMap((b, i) => (b.kind === 'table' ? [i] : []));
    const named = block === undefined ? undefined : document.blocks[block];
    if (block === undefined || named?.kind !== 'table') {
      throw refuse(
        'STATUS_REPORT_REFUSED',
        `${
          block === undefined
            ? 'a CSV export names its table with block=<index>'
            : named
              ? `block ${block} is a ${named.kind}, not a table`
              : `block ${block} is not in this report, which holds ${document.blocks.length} block(s)`
        }; this report's table blocks are ${tables.length > 0 ? tables.join(', ') : 'none'}`,
        '/block',
      );
    }
    return c.body(tableCsv(named), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exportName(templateId, detail.report.asOf, 'csv', block)}"`,
    });
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
