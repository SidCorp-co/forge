import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  createChatSessionRow,
  dispatchChatTurn,
  noClaudeClient,
  resolveChatDevice,
} from '../agent-sessions/chat-turn.js';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { logger } from '../logger.js';
import type { AuthVars } from '../middleware/auth.js';
import { resolveRegisteredEffectiveSkills } from '../skills/effective.js';
import { requestSkillSync } from '../skills/service.js';

// ISS-733 — the "Build Project Brain" trigger: web calls this once, after
// bootstrap, to open a fresh chat session that runs `forge-onboard` as turn 1
// (the chat-runs-skill mechanism in `agent-sessions/chat-turn.ts`). Mirrors
// the dedup-free dispatch shape of `integrations/rocketchat/agent-chat.ts`
// (resolveChatDevice → createChatSessionRow → dispatchChatTurn), plus an
// explicit skill-sync push first since sync is explicit-only (the runner
// won't have the file on disk otherwise).

const ONBOARD_SKILL_NAME = 'forge-onboard';
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
  zValidator('param', onboardParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    // Same gate as skills/bootstrap: this kicks off a conversation that can
    // end up proposing projectFacts/pipelineConfig changes, so treat starting
    // it as a project-setup action.
    const access = await loadProjectAccess(id, userId);
    assertProjectRole(access, 'admin', 'project admin required');

    const [project] = await db
      .select({ id: projects.id, slug: projects.slug, repoPath: projects.repoPath })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!project) throw new HTTPException(404, { message: 'project not found' });

    // Only proceed when the project actually owns an install_only forge-onboard
    // copy (seeded by bootstrap) — a project bootstrapped before ISS-733, or
    // whose bootstrap silently skipped it (missing global template on an old
    // server build), gets a clear error instead of a slash-command that
    // resolves to nothing on the runner.
    const effective = await resolveRegisteredEffectiveSkills(project.id);
    if (!effective.some((s) => s.name === ONBOARD_SKILL_NAME && s.installOnly)) {
      throw new HTTPException(503, {
        message: 'forge-onboard is not installed for this project — re-run pipeline bootstrap',
        cause: { code: 'ONBOARD_SKILL_MISSING' },
      });
    }

    const client = await resolveChatDevice(
      { projectId: project.id, deviceId: null, metadata: null },
      undefined,
    );
    if (!client.deviceId) throw noClaudeClient('project');

    // Explicit-only skill sync: push the current forge-onboard manifest to the
    // target device BEFORE dispatch, so the runner's working dir has the file
    // on disk when `claude -p` cold-starts (sync never happens implicitly).
    const sync = await requestSkillSync({
      projectId: project.id,
      actorUserId: userId,
      skillNames: [ONBOARD_SKILL_NAME],
      deviceId: client.deviceId,
    });
    if (sync.deviceIds.length === 0) {
      throw new HTTPException(503, {
        message: 'no device-bound runner available to sync forge-onboard to',
        cause: { code: 'NO_SYNC_TARGET' },
      });
    }

    const session = await createChatSessionRow({
      projectId: project.id,
      userId,
      title: 'Build Project Brain',
      repoPath: project.repoPath,
      metadata: { source: 'onboard' },
    });

    try {
      await dispatchChatTurn({
        session,
        project,
        client,
        message: ONBOARD_MESSAGE,
        skillName: ONBOARD_SKILL_NAME,
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

    return c.json({ sessionId: session.id }, 201);
  },
);
