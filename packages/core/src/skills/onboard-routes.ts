import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  authorizeInteractiveTurn,
  createChatSessionRow,
  dispatchInteractiveTurn,
  noClaudeClient,
  resolveInteractiveClient,
} from '../agent-sessions/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { resolveSessionRepoPathForDevice } from '../lib/device-pool.js';
import type { AuthVars } from '../middleware/auth.js';
import { badRequest } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { logger } from '../observability/logger.js';
import { requireHeld } from '../permissions/index.js';
import { projectHead } from '../projects/index.js';
import { resolveRegisteredEffectiveSkills } from './effective.js';
import { requestSkillSync } from './service.js';

// ISS-733 — the "Build Project Brain" trigger: web calls this once, after
// bootstrap, to open a fresh chat session that runs `forge-onboard` as turn 1
// (the chat-runs-skill mechanism in `agent-sessions/chat-turn.ts`). Mirrors
// the dedup-free dispatch shape of `conversations/conversation-agent.ts`
// (resolveChatDevice → createChatSessionRow → dispatchChatTurn), plus an
// explicit skill-sync push first since sync is explicit-only (the runner
// won't have the file on disk otherwise).

const ONBOARD_SKILL_NAME = 'forge-onboard';
const ONBOARD_MESSAGE =
  'Build the Project Brain for this project: survey the repo, then walk me through what you find before writing anything.';

const onboardParamSchema = z.object({ id: z.uuid() });

// NOTE: mounted by the route registry right after `projectRoutes`, whose
// requireAuth() + assertEmailVerified() gate the whole /api/projects surface —
// no own auth middleware here, or it would run twice.
export const projectOnboardRoutes = new Hono<{ Variables: AuthVars }>();

projectOnboardRoutes.post(
  '/:id/onboard',
  zValidator('param', onboardParamSchema, (result) => {
    if (!result.success) throw badRequest(result.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(id, userId);
    requireHeld(access, 'project.admin');

    const project = await projectHead(id);
    if (!project) throw new HTTPException(404, { message: 'project not found' });

    const effective = await resolveRegisteredEffectiveSkills(project.id);
    if (!effective.some((s) => s.name === ONBOARD_SKILL_NAME && s.installOnly)) {
      throw new HTTPException(503, {
        message:
          'forge-onboard is not installed for this project. It is a reserved meta skill that no project route adopts, so onboarding cannot start until it is installed.',
        cause: { code: 'ONBOARD_SKILL_MISSING' },
      });
    }

    const client = await resolveInteractiveClient(
      { projectId: project.id, deviceId: null, metadata: null },
      { scope: 'project' },
    );
    if (!client.deviceId) throw noClaudeClient('project');
    const authority = await authorizeInteractiveTurn({
      client,
      projectId: project.id,
      asker: { userId, viaTokenId: c.get('patTokenId') ?? null },
    });

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
      repoPath: await resolveSessionRepoPathForDevice(project.id, client.deviceId),
      metadata: { source: 'onboard' },
    });

    try {
      await dispatchInteractiveTurn({
        session,
        project,
        client,
        authority,
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
