import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { PromptRefusalCode } from '@forge/contracts/prompt';
import { z } from 'zod';
import { type JobType, jobTypes } from '../db/schema.js';
import { buildJobSystemPrompt } from '../jobs/job-system-prompt.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { RUNNER_CAPABILITIES } from '../pipeline/registry.js';
import { dispatchStateOf, requirePolicy } from '../project-config/dispatch-policy.js';
import { loadIssueSnapshot } from './issue-snapshot.js';
import { buildJobPromptString } from './user.js';
import { requireHeld } from '../permissions/index.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const notFound = (m: string) =>
  new HTTPException(404, { message: m, cause: { code: 'NOT_FOUND' } });

const refuse = refuser<PromptRefusalCode>('PROMPT_REFUSED');

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
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const body = c.req.valid('json');
    const userId = c.get('userId');

    // Project-member auth — same as jobRoutes.get('/:id').
    // loadProjectAccess throws 404 if the project does not exist.
    const access = await loadProjectAccess(body.projectId, userId);
    requireHeld(access, 'project.read');

    if (!PREVIEWABLE_STATES.includes(body.state)) {
      throw refuse(
        'STATE_NOT_CLAIMABLE',
        `no runner can claim a \`${body.state}\` job, so there is no prompt it would see: a job of that type is refused \`runner_unsupported_type\` before a prompt is built. It is still in the job-type enum only so historical \`jobs\` rows stay readable. Previewable states: ${PREVIEWABLE_STATES.join(', ')}.`,
        '/state',
      );
    }

    // Scope the issue lookup to body.projectId (the caller is gated as a member
    // above): an issueId belonging to a DIFFERENT project resolves to null and
    // 404s below instead of leaking that issue's content (ISS-492).
    const issueSnapshot =
      body.issueId !== undefined ? await loadIssueSnapshot(body.issueId, body.projectId) : null;
    if (body.issueId !== undefined && !issueSnapshot) {
      throw notFound('issue not found');
    }

    const held = await requirePolicy(body.projectId);
    const policy = dispatchStateOf(body.projectId, held, {
      status: issueSnapshot?.status ?? null,
      from: 'issue',
    });

    // cm:why the preview calls the builder prepare calls (jobs/job-system-prompt.ts), so the
    // requirement, design and contract blocks a claimed job is given are the ones shown here
    const built = await buildJobSystemPrompt({
      projectId: body.projectId,
      issueId: body.issueId ?? null,
      step: body.state as JobType,
      policy,
      subject: `preview refused issue ${body.issueId ?? 'none'}`,
    });
    const { systemPrompt, blocks } = built;

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
        deniedTools: built.deniedTools,
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
