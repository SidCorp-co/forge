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

// cm:edge contract -> packages/core/src/ux-findings/service.ts — the SAME cap the MCP tool enforced, and it must stay a shared number rather than a per-surface one: the cap is per (issue, run) and both surfaces write the same rows, so two different limits would let a caller alternate surfaces to exceed either.
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

    // cm:guard 404, not 403, for an issue outside this project — the caller is already proven a member HERE, so the only thing a distinct status would reveal is whether that issue id exists somewhere they cannot see. A finding is never written against an issue the caller cannot see.
    if (!(await issueBelongsToProject(issueId, projectId))) {
      throw new HTTPException(404, {
        message: 'issue not found in this project',
        cause: { code: 'NOT_FOUND' },
      });
    }

    // cm:guard runId is NULL on this path and that is deliberate, not missing data: a REST caller has no active job to attribute the finding to, and borrowing one would credit the wrong pass. `countFindingsFor` matches it with isNull for the same reason — `eq(col, null)` is never true and would silently stop capping.
    if ((await countFindingsFor(issueId, null)) >= MAX_FINDINGS_PER_ISSUE) {
      throw new HTTPException(429, {
        message: 'too many findings for this issue',
        cause: { code: 'RATE_LIMITED', details: { limit: MAX_FINDINGS_PER_ISSUE } },
      });
    }

    // cm:guard a ruleId from another project is dropped to null, NOT refused — it would FK-fail the insert and lose a real finding over a stale id the agent had no way to check. The finding is the thing worth keeping; the rule link is not.
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
