import {
  supportProposeFixRequestSchema,
  supportRecordRequestSchema,
  supportReplyRequestSchema,
  supportRunRequestSchema,
  supportSearchRequestSchema,
  supportThreadRequestSchema,
} from '@forge/contracts/support';
import {
  operationsDraftFeedbackRequestSchema,
  operationsDraftRequirementRequestSchema,
  operationsIssuesRequestSchema,
  operationsMoveRequestSchema,
  operationsReleasesRequestSchema,
  operationsResearchRequestSchema,
} from '@forge/contracts/support-operations';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { type SupportActInput, supportAct } from './acts.js';
import { supportActionsOf, supportRoomsOf } from './read.js';

/**
 * A support group's and an operations room's doors (REQ-75). The session's acts, under
 * `/support/session/*`, admit only the room's own session holding its current turn's token
 * (`access.ts`); the reads admit a project reader.
 */
export const supportRoutes = new Hono<{ Variables: AuthVars }>();

supportRoutes.use('/:id/support/*', requireAuth());

const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);
const roomParam = zValidator(
  'param',
  z.object({ id: z.uuid(), roomId: z.uuid() }),
  invalid('invalid path: a project uuid and a support room uuid'),
);

async function act(c: Context<{ Variables: AuthVars }>, projectId: string, input: SupportActInput) {
  const out = await supportAct(
    { userId: c.get('userId'), tokenId: c.get('patTokenId'), projectId },
    input,
  );
  if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
  return c.json(out.value as Record<string, unknown>);
}

const SHAPES = {
  search: '{ query }',
  thread: '{ thread }',
  reply: '{ thread, text }',
  run: '{ thread, tool, args? }',
  fix: '{ thread, tool, args?, asker }',
  record: '{ thread, kind: defect | feature | request, title, summary, whereSeen?, asker? }',
  issues: '{ project, status?, key? }',
  releases: '{ project }',
  move: '{ thread, issue, to, reason?, project? }',
  requirementDraft: '{ thread, project, title, summary }',
  feedbackDraft:
    '{ thread, project, kind: defect | feature | request, title, summary, one of requirement | issue | screen }',
  research: '{ thread, url }',
} as const;

supportRoutes.post(
  '/:id/support/session/search',
  projectParam,
  strictBody(supportSearchRequestSchema, SHAPES.search),
  (c) => act(c, c.req.valid('param').id, { action: 'search', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/thread',
  projectParam,
  strictBody(supportThreadRequestSchema, SHAPES.thread),
  (c) => act(c, c.req.valid('param').id, { action: 'thread', ...c.req.valid('json') }),
);
supportRoutes.get('/:id/support/session/tools', projectParam, (c) =>
  act(c, c.req.valid('param').id, { action: 'tools' }),
);
supportRoutes.post(
  '/:id/support/session/replies',
  projectParam,
  strictBody(supportReplyRequestSchema, SHAPES.reply),
  (c) => act(c, c.req.valid('param').id, { action: 'reply', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/checks',
  projectParam,
  strictBody(supportRunRequestSchema, SHAPES.run),
  (c) => act(c, c.req.valid('param').id, { action: 'run', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/fixes',
  projectParam,
  strictBody(supportProposeFixRequestSchema, SHAPES.fix),
  (c) => act(c, c.req.valid('param').id, { action: 'propose_fix', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/records',
  projectParam,
  strictBody(supportRecordRequestSchema, SHAPES.record),
  (c) => act(c, c.req.valid('param').id, { action: 'record', ...c.req.valid('json') }),
);

// an operations room's acts (REQ-75 BC-20..BC-24): read the scope, move delivery, draft direction, research
supportRoutes.get('/:id/support/session/projects', projectParam, (c) =>
  act(c, c.req.valid('param').id, { action: 'projects' }),
);
supportRoutes.post(
  '/:id/support/session/issues',
  projectParam,
  strictBody(operationsIssuesRequestSchema, SHAPES.issues),
  (c) => act(c, c.req.valid('param').id, { action: 'issues', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/releases',
  projectParam,
  strictBody(operationsReleasesRequestSchema, SHAPES.releases),
  (c) => act(c, c.req.valid('param').id, { action: 'releases', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/moves',
  projectParam,
  strictBody(operationsMoveRequestSchema, SHAPES.move),
  (c) => act(c, c.req.valid('param').id, { action: 'move', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/requirement-drafts',
  projectParam,
  strictBody(operationsDraftRequirementRequestSchema, SHAPES.requirementDraft),
  (c) => act(c, c.req.valid('param').id, { action: 'draft_requirement', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/feedback-drafts',
  projectParam,
  strictBody(operationsDraftFeedbackRequestSchema, SHAPES.feedbackDraft),
  (c) => act(c, c.req.valid('param').id, { action: 'draft_feedback', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/research',
  projectParam,
  strictBody(operationsResearchRequestSchema, SHAPES.research),
  (c) => act(c, c.req.valid('param').id, { action: 'research', ...c.req.valid('json') }),
);

supportRoutes.get('/:id/support/rooms', projectParam, async (c) => {
  const rooms = await supportRoomsOf(c.get('userId'), c.req.valid('param').id);
  return c.json({ rooms });
});

supportRoutes.get('/:id/support/rooms/:roomId/actions', roomParam, async (c) => {
  const { id, roomId } = c.req.valid('param');
  const actions = await supportActionsOf(c.get('userId'), id, roomId);
  if (!actions) {
    return refused(
      c,
      [
        {
          code: 'SUPPORT_ROOM_UNKNOWN',
          path: '/roomId',
          detail: `this project holds no support room ${roomId}`,
        },
      ],
      'SUPPORT_REFUSED',
    );
  }
  return c.json({ actions });
});
