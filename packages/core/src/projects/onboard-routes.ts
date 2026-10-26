import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  createChatSessionRow,
  dispatchChatTurn,
  noClaudeClient,
  resolveChatDevice,
} from '../agent-sessions/chat-turn.js';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { projects, skills } from '../db/schema.js';
import { assertRoleFor, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import type { AuthVars } from '../middleware/auth.js';
import { globalEffectiveMd } from '../skills/effective.js';
import { onboardStartedSchema, startOnboarding } from './onboard-routes-reference.js';

// ISS-733 — the "Build Project Brain" trigger: web calls this once, after
// bootstrap, to open a fresh chat session whose first turn runs `forge-onboard`.
// `forge-onboard` is a Forge-owned skill (META_SKILL_NAMES), so no project holds
// a copy of it and none can create one: the device is handed its instructions
// from the global row, as Forge's other owned agents are (ISS-1236 round 2).

const ONBOARD_SKILL_NAME = 'forge-onboard';

/** Forge's own `forge-onboard`, refused by name where core's builtin seed did not load it. */
async function forgeOnboardInstructions(): Promise<string> {
  const [row] = await db
    .select({ skillMd: skills.skillMd, prompt: skills.prompt })
    .from(skills)
    .where(and(eq(skills.scope, 'global'), eq(skills.name, ONBOARD_SKILL_NAME)))
    .limit(1);
  const body = row ? globalEffectiveMd(row) : '';
  if (!body) {
    throw new HTTPException(503, {
      message:
        "Forge's own forge-onboard skill is not loaded on this server: the builtin skills are seeded when core starts, and this one was not. Nothing in this project can install it; the server's operator restarts core or reads its startup log for the seed's error.",
      cause: { code: 'ONBOARD_SKILL_MISSING' },
    });
  }
  return body;
}

const ONBOARD_MESSAGE =
  'Build the Project Brain for this project: survey the repo, then walk me through what you find before writing anything.';

const onboardParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

// NOTE: mounted under `projectRoutes` (see ./routes.ts), which applies
// requireAuth() + assertEmailVerified() for the whole /api/projects surface —
// no own auth middleware here, or it would run twice.
export const projectOnboardRoutes = new Hono<{ Variables: AuthVars }>();

projectOnboardRoutes.post(
  '/:id/onboard',
  startOnboarding,
  zValidator('param', onboardParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    assertRoleFor(access, 'admin', 'onboard it');

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!project) throw new HTTPException(404, { message: 'project not found' });

    const instructions = await forgeOnboardInstructions();

    const client = await resolveChatDevice(
      { projectId: project.id, deviceId: null, metadata: null },
      undefined,
    );
    if (!client.deviceId) throw noClaudeClient('project');

    const session = await createChatSessionRow({
      projectId: project.id,
      userId,
      title: 'Build Project Brain',
      metadata: { source: 'onboard' },
    });

    try {
      await dispatchChatTurn({
        session,
        project,
        client,
        message: ONBOARD_MESSAGE,
        instructions,
        broadcastEvent: 'agent-session.created',
      });
    } catch (err) {
      logger.error(
        { err, sessionId: session.id, projectId: project.id },
        'projects/onboard: chat-turn dispatch failed',
      );
      throw new HTTPException(502, {
        message: 'failed to start the onboarding conversation',
        cause: { code: 'DISPATCH_FAILED' },
      });
    }

    return c.json(answer(onboardStartedSchema, { sessionId: session.id }), 201);
  },
);
