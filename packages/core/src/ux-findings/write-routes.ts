/**
 * Recording a UX finding over REST — the write half of `forge_ux_findings`,
 * which had a `GET /:id/ux-findings` and no way to write one.
 *
 * The MCP tool resolved the target issue from the calling device's active job.
 * REST has no device, so the issue is named explicitly — the same escape hatch
 * the tool documented, promoted to the only path.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { uxFindingKinds, uxFindingStages } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  countFindingsFor,
  insertUxFinding,
  issueBelongsToProject,
  resolveProjectRuleId,
} from './service.js';

const MAX_FINDINGS_PER_ISSUE = 50;

const paramSchema = z.object({ id: z.uuid() });

const bodySchema = z
  .object({
    issueId: z.uuid(),
    stage: z.enum(uxFindingStages),
    kind: z.enum(uxFindingKinds),
    detail: z.string().trim().min(1).max(4000),
    severity: z.enum(['must', 'should']).default('must'),
    ruleId: z.uuid().optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const uxFindingWriteRoutes = new Hono<{ Variables: AuthVars }>();
uxFindingWriteRoutes.use('/:id/ux-findings', requireAuth(), assertEmailVerified());

uxFindingWriteRoutes.post(
  '/:id/ux-findings',
  zValidator('param', paramSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', bodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { issueId, stage, kind, detail, severity, ruleId } = c.req.valid('json');

    const access = await loadProjectAccess(projectId, c.get('userId'));
    assertProjectRole(access, 'member', 'not a project member');

    if (!(await issueBelongsToProject(issueId, projectId))) {
      throw new HTTPException(404, {
        message: 'issue not found in this project',
        cause: { code: 'NOT_FOUND' },
      });
    }

    if ((await countFindingsFor(issueId, null)) >= MAX_FINDINGS_PER_ISSUE) {
      throw new HTTPException(429, {
        message: 'too many findings for this issue',
        cause: { code: 'RATE_LIMITED', details: { limit: MAX_FINDINGS_PER_ISSUE } },
      });
    }

    const resolvedRuleId = ruleId ? await resolveProjectRuleId(ruleId, projectId) : null;

    const id = await insertUxFinding({
      projectId,
      issueId,
      runId: null,
      stage,
      ruleId: resolvedRuleId,
      kind,
      detail,
      severity,
    });
    return c.json({ id }, 201);
  },
);
