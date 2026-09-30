import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type JobType, jobTypes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';
import {
  type DispatchState,
  dispatchStateOf,
  PolicyRefusedError,
  requirePolicy,
} from '../project-config/dispatch-policy.js';
import { loadIssueSnapshot } from './issue-snapshot.js';
import { buildPipelinePreambleStructured } from './system.js';
import { buildJobPromptString } from './user.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const forbidden = (m: string) =>
  new HTTPException(403, { message: m, cause: { code: 'FORBIDDEN' } });
const notFound = (m: string) =>
  new HTTPException(404, { message: m, cause: { code: 'NOT_FOUND' } });

const PREVIEWABLE_STATES = [...new Set(Object.values(RUNNER_CAPABILITIES).flat())].sort();

const previewBodySchema = z
  .object({
    projectId: z.uuid(),
    state: z.enum(jobTypes),
    issueId: z.uuid().optional(),
    skillName: z.string().min(1).max(128).optional(),
  })
  .strict();

export const promptRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Build the system + user prompt the runner WOULD see for `state` on the given issue, under the
 * project's policy. Read-only: it enqueues nothing. A project the dispatcher would refuse is
 * refused here by the same name.
 */
promptRoutes.post(
  '/preview',
  requireAuth(),
  assertEmailVerified(),
  zValidator('json', previewBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');

    // Project-member auth — same as jobRoutes.get('/:id').
    // loadProjectAccess throws 404 if the project does not exist.
    const access = await loadProjectAccess(body.projectId, userId);
    if (!access.role) {
      throw forbidden('not a project member');
    }

    if (!PREVIEWABLE_STATES.includes(body.state)) {
      throw new HTTPException(400, {
        message: `no runner can claim a \`${body.state}\` job, so there is no prompt it would see: a job of that type is refused \`runner_unsupported_type\` before a prompt is built. It is still in the job-type enum only so historical \`jobs\` rows stay readable. Previewable states: ${PREVIEWABLE_STATES.join(', ')}.`,
        cause: {
          code: 'STATE_NOT_CLAIMABLE',
          details: { state: body.state, previewableStates: PREVIEWABLE_STATES },
        },
      });
    }

    // Scope the issue lookup to body.projectId (the caller is gated as a member
    // above): an issueId belonging to a DIFFERENT project resolves to null and
    // 404s below instead of leaking that issue's content (ISS-492).
    const issueSnapshot =
      body.issueId !== undefined ? await loadIssueSnapshot(body.issueId, body.projectId) : null;
    if (body.issueId !== undefined && !issueSnapshot) {
      throw notFound('issue not found');
    }

    let policy: DispatchState;
    try {
      const held = await requirePolicy(body.projectId);
      policy = dispatchStateOf(body.projectId, held, {
        status: issueSnapshot?.status ?? null,
        from: 'issue',
      });
    } catch (err) {
      if (err instanceof PolicyRefusedError) {
        throw new HTTPException(409, { message: err.message, cause: { code: err.code } });
      }
      throw err;
    }

    const { content: systemPrompt, blocks } = await buildPipelinePreambleStructured(
      body.projectId,
      { step: body.state as JobType, policy },
    );

    const userPrompt = buildJobPromptString({
      skillName: body.skillName ?? null,
      jobType: body.state as JobType,
      issueId: body.issueId ?? 'preview-no-issue',
      issueSnapshot,
    });

    // Hash combines system + user, so diff between previews is detectable
    // via hash alone in the UI before fetching the full content.
    const hash = await sha256Hex(`${systemPrompt}\n---\n${userPrompt}`);

    return c.json({
      systemPrompt,
      userPrompt,
      blocks,
      hash,
      resolvedFlags: {
        state: body.state,
        skillName: body.skillName ?? `forge-${body.state}`,
        policyRevision: policy.revision,
        policyState: policy.status,
        policyStateFrom: policy.from,
        model: policy.model,
        deniedTools: policy.deniedTools,
      },
    });
  },
);

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
