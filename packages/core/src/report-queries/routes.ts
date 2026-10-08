import type { ReportQueryDescriptorView } from '@forge/contracts/report-queries';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { runReport } from '../reports/index.js';
import { listReportQueries } from './registry.js';

const runParam = z.strictObject({ id: z.uuid(), queryId: z.string().min(1).max(64) });
const runBody = z.strictObject({ params: z.record(z.string(), z.unknown()).optional() });

export const reportQueryRoutes = new Hono<{ Variables: AuthVars }>();
reportQueryRoutes.use('/projects/:id/report-queries', requireAuth(), assertEmailVerified());
reportQueryRoutes.use('/projects/:id/report-queries/*', requireAuth(), assertEmailVerified());

const listParam = z.strictObject({ id: z.uuid() });

/**
 * Every registered query's descriptor, `params` carried as its JSON Schema. A project read, so a
 * personal or agent token reaches it under `projects:read` like any other, and a member sees it.
 */
reportQueryRoutes.get(
  '/projects/:id/report-queries',
  zValidator('param', listParam, invalid('invalid path: /api/projects/<project>/report-queries')),
  async (c) => {
    const access = await loadProjectAccess(c.req.valid('param').id, c.get('userId'));
    requireHeld(access, 'project.read', 'list the report queries');
    const queries: ReportQueryDescriptorView[] = listReportQueries().map(({ descriptor }) => ({
      id: descriptor.id,
      version: descriptor.version,
      title: descriptor.title,
      params: z.toJSONSchema(descriptor.params.strict()) as Record<string, unknown>,
      output: [...descriptor.output],
      permission: descriptor.permission,
      egress: descriptor.egress,
      surfaces: [...descriptor.surfaces],
    }));
    return c.json({ queries });
  },
);

/** Runs one query as the caller and keeps the run; refused by name unless the caller holds what the query declares. */
reportQueryRoutes.post(
  '/projects/:id/report-queries/:queryId/runs',
  zValidator(
    'param',
    runParam,
    invalid('invalid path: /api/projects/<project>/report-queries/<query>/runs'),
  ),
  zValidator('json', runBody, invalid('invalid body: { params?: { <name>: <value> } }')),
  async (c) => {
    const { id: projectId, queryId } = c.req.valid('param');
    const agency = c.get('agency');
    if (!agency)
      throw new Error('report queries: a request reached its handler without an auth gate');
    const userId = c.get('userId');
    const access = await loadProjectAccess(projectId, userId);
    const run = await runReport({
      projectId,
      queryId,
      params: c.req.valid('json').params,
      asker: { userId, agency, access },
      surface: 'rest',
    });
    return c.json(run);
  },
);
