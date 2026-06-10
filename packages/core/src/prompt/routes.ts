import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type JobType, jobTypes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
} from '../middleware/auth.js';
// Single source of truth for stage-override schemas. Reused here so the
// preview endpoint inherits the F12 refinement (replace mode requires
// non-empty extras) and any future invariants stay in lockstep.
import {
  systemPromptOverrideSchema,
  userPromptPolicySchema,
} from '../pipeline/pipeline-config-schema.js';
import { loadIssueSnapshot } from './issue-snapshot.js';
import {
  buildPipelinePreambleStructured,
  type SystemPromptOverride,
} from './system.js';
import {
  buildJobPromptString,
  type UserPromptPolicyOverride,
} from './user.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });
const forbidden = (m: string) =>
  new HTTPException(403, { message: m, cause: { code: 'FORBIDDEN' } });
const notFound = (m: string) =>
  new HTTPException(404, { message: m, cause: { code: 'NOT_FOUND' } });

const previewBodySchema = z
  .object({
    projectId: z.uuid(),
    state: z.enum(jobTypes),
    issueId: z.uuid().optional(),
    skillName: z.string().min(1).max(128).optional(),
    overrides: z
      .object({
        systemPrompt: systemPromptOverrideSchema.optional(),
        userPromptPolicy: userPromptPolicySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const promptRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Build the system + user prompt the runner WOULD see for `state` on the
 * given issue, applying optional per-state overrides. Read-only — does not
 * mutate `projects.appConfig` or enqueue anything. Used by the State Editor
 * UI for live preview and by operators to debug prompt resolution.
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

    const systemPromptOverride: SystemPromptOverride | null =
      body.overrides?.systemPrompt ?? null;
    const userPromptPolicy: UserPromptPolicyOverride | null =
      body.overrides?.userPromptPolicy ?? null;

    const { content: systemPrompt, blocks } = await buildPipelinePreambleStructured(
      body.projectId,
      { step: body.state as JobType, override: systemPromptOverride },
    );

    const issueSnapshot =
      body.issueId !== undefined ? await loadIssueSnapshot(body.issueId) : null;
    if (body.issueId !== undefined && !issueSnapshot) {
      throw notFound('issue not found');
    }

    const userPrompt = buildJobPromptString({
      skillName: body.skillName ?? null,
      jobType: body.state as JobType,
      issueId: body.issueId ?? 'preview-no-issue',
      issueSnapshot,
      policy: userPromptPolicy,
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
        systemPromptMode: systemPromptOverride?.mode ?? 'append',
        hasUserPromptPolicyOverride: userPromptPolicy !== null,
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
