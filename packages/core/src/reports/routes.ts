import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { attachVisualBlock } from './blocks.js';
import { readReportRun } from './runs.js';
import { checkTemplateNarrative, listReportTemplates, runTemplate } from './templates.js';

const runParam = z.strictObject({ id: z.uuid(), runId: z.string().min(1).max(64) });
const templateParam = z.strictObject({ id: z.uuid(), templateId: z.string().min(1).max(64) });
const listParam = z.strictObject({ id: z.uuid() });
const templateBody = z.strictObject({ params: z.record(z.string(), z.unknown()).optional() });
const narrativeBody = z.strictObject({
  runIds: z.array(z.string().min(1).max(64)).min(1).max(12),
  narrative: z.strictObject({
    summary: z.string().optional(),
    risks: z.string().optional(),
    recommendations: z.string().optional(),
  }),
});
const roomParam = z.strictObject({ id: z.uuid() });
const blockBody = z.strictObject({
  projectId: z.uuid(),
  block: z.record(z.string(), z.unknown()),
});

export const reportRoutes = new Hono<{ Variables: AuthVars }>();
reportRoutes.use('/projects/:id/report-runs/*', requireAuth(), assertEmailVerified());
reportRoutes.use('/projects/:id/report-templates', requireAuth(), assertEmailVerified());
reportRoutes.use('/projects/:id/report-templates/*', requireAuth(), assertEmailVerified());
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

/** The templates this build offers, with the params each takes. */
reportRoutes.get(
  '/projects/:id/report-templates',
  zValidator('param', listParam, invalid('invalid path: /api/projects/<project>/report-templates')),
  async (c) => {
    // a member's list: the project is read through its access, so a token fenced off it is refused
    await loadProjectAccess(c.req.valid('param').id, c.get('userId'));
    return c.json({ templates: listReportTemplates() });
  },
);

/**
 * Agent mode's door to forge_template: runs the template's queries as the caller, keeps each run,
 * and answers the document with its blocks and the slots to write; the narrative is left empty.
 */
reportRoutes.post(
  '/projects/:id/report-templates/:templateId/runs',
  zValidator(
    'param',
    templateParam,
    invalid('invalid path: /api/projects/<project>/report-templates/<template>/runs'),
  ),
  zValidator('json', templateBody, invalid('invalid body: { params?: { <name>: <value> } }')),
  async (c) => {
    const { id: projectId, templateId } = c.req.valid('param');
    const userId = c.get('userId');
    const result = await runTemplate({
      projectId,
      templateId,
      params: c.req.valid('json').params,
      asker: {
        userId,
        agency: gated(c.get('agency')),
        access: await loadProjectAccess(projectId, userId),
      },
      surface: 'rest',
    });
    return c.json(result);
  },
);

/** Judges a narrative against the template's own runs; answers the document with it set, or refuses by name. */
reportRoutes.post(
  '/projects/:id/report-templates/:templateId/narrative',
  zValidator(
    'param',
    templateParam,
    invalid('invalid path: /api/projects/<project>/report-templates/<template>/narrative'),
  ),
  zValidator(
    'json',
    narrativeBody,
    invalid(
      'invalid body: { runIds: [<run of each template query, in order>], narrative: { summary?, risks?, recommendations? } }',
    ),
  ),
  async (c) => {
    const { id: projectId, templateId } = c.req.valid('param');
    const { runIds, narrative } = c.req.valid('json');
    const document = await checkTemplateNarrative({
      projectId,
      templateId,
      runIds,
      narrative,
      userId: c.get('userId'),
      agency: gated(c.get('agency')),
    });
    return c.json(document);
  },
);
