import { Hono } from 'hono';
import { z } from 'zod';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { attachVisualBlock } from './blocks.js';
import { readReportRun } from './runs.js';

const runParam = z.strictObject({ id: z.uuid(), runId: z.string().min(1).max(64) });
const roomParam = z.strictObject({ id: z.uuid() });
const blockBody = z.strictObject({
  projectId: z.uuid(),
  block: z.record(z.string(), z.unknown()),
});

export const reportRoutes = new Hono<{ Variables: AuthVars }>();
reportRoutes.use('/projects/:id/report-runs/*', requireAuth(), assertEmailVerified());
reportRoutes.use('/conversations/:id/blocks', requireAuth(), assertEmailVerified());

function gated<T>(agency: T | undefined): T {
  if (!agency) throw new Error('reports: a request reached its handler without an auth gate');
  return agency;
}

/** One stored run, read back by the person it was read as; refused by name when gone or not theirs. */
reportRoutes.get(
  '/projects/:id/report-runs/:runId',
  zValidator('param', runParam, invalid('invalid path: /api/projects/<project>/report-runs/<run>')),
  async (c) => {
    const { id: projectId, runId } = c.req.valid('param');
    const agency = gated(c.get('agency'));
    const run = await readReportRun({ runId, projectId, userId: c.get('userId'), agency });
    const frame = await egressForRequest(
      agency,
      projectId,
      'requirement',
      run.frame,
      `report run ${runId}`,
    );
    return c.json({ ...run, frame });
  },
);

/**
 * Agent mode's door to the block service the chat's forge_show calls: one block of a run the caller
 * made, posted into the room as the project's answer.
 */
reportRoutes.post(
  '/conversations/:id/blocks',
  zValidator('param', roomParam, invalid('invalid path: /api/conversations/<conversation>/blocks')),
  zValidator(
    'json',
    blockBody,
    invalid('invalid body: { projectId: <uuid>, block: { kind, source: { runId }, ...fields } }'),
  ),
  async (c) => {
    const { id: conversationId } = c.req.valid('param');
    const { projectId, block } = c.req.valid('json');
    const attached = await attachVisualBlock({
      conversationId,
      projectId,
      raw: block,
      asker: { userId: c.get('userId'), agency: gated(c.get('agency')) },
    });
    return c.json(attached, 201);
  },
);
