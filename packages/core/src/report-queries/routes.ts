import type { ReportQueryDescriptorView } from '@forge/contracts/report-queries';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import {
  getReportQuery,
  listReportQueries,
  ReportParamsRefusedError,
  UnknownReportQueryError,
} from './registry.js';
import { runReportQuery } from './run.js';

const runParam = z.strictObject({ id: z.uuid(), queryId: z.string().min(1).max(64) });
const runBody = z.strictObject({ params: z.record(z.string(), z.unknown()).optional() });

export const reportQueryRoutes = new Hono<{ Variables: AuthVars }>();
reportQueryRoutes.use('/report-queries', requireAuth(), assertEmailVerified());
reportQueryRoutes.use('/projects/:id/report-queries/*', requireAuth(), assertEmailVerified());

/** Every registered query's descriptor, `params` carried as its JSON Schema. */
reportQueryRoutes.get('/report-queries', (c) => {
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
});

/** Runs one query as the caller; refused by name unless the caller holds what the query declares. */
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
    let run: Awaited<ReturnType<typeof runReportQuery>>;
    try {
      const { egress } = getReportQuery(queryId).descriptor;
      if (egress !== 'product') {
        throw new Error(
          `report query "${queryId}" is ${egress}-class and no egress surface is declared for it; add the surface before registering it`,
        );
      }
      const access = await loadProjectAccess(projectId, userId);
      run = await runReportQuery({
        projectId,
        queryId,
        params: c.req.valid('json').params,
        asker: { userId, agency, access },
      });
    } catch (e) {
      if (e instanceof UnknownReportQueryError) throw notFound(e.message);
      if (e instanceof ReportParamsRefusedError)
        throw badRequest(e.message, 'REPORT_PARAMS_REFUSED');
      throw e;
    }
    const frame = await egressForRequest(
      agency,
      projectId,
      'requirement',
      run.frame,
      `the report query ${queryId}`,
    );
    return c.json({ ...run, frame });
  },
);
