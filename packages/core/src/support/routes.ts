import {
  supportAgreeRequestSchema,
  supportBuildRequestSchema,
  supportCommandRequestSchema,
  supportDeploymentRequestSchema,
  supportDeployRequestSchema,
  supportImageRequestSchema,
  supportLinkRequestSchema,
  supportMoveIssueRequestSchema,
  supportProjectSlugSchema,
  supportProposeFixRequestSchema,
  supportReadRequestSchema,
  supportRecordRequestSchema,
  supportReplyRequestSchema,
  supportRunRequestSchema,
  supportSearchRequestSchema,
  supportThreadRequestSchema,
} from '@forge/contracts/support';
import {
  supportAnnounceRequestSchema,
  supportAnswerQuestionRequestSchema,
  supportAskOwnerRequestSchema,
  supportCheckResultRequestSchema,
  supportCommonIssueRequestSchema,
  supportGitCredentialRequestSchema,
  supportMasterPostRequestSchema,
  supportMemberRequestSchema,
  supportRouteRequestSchema,
  supportRuleRequestSchema,
} from '@forge/contracts/support-channel';
import {
  operationsDraftFeedbackRequestSchema,
  operationsDraftRequirementRequestSchema,
  operationsIssuesRequestSchema,
  operationsMoveRequestSchema,
  operationsReleasesRequestSchema,
  operationsRequirementsRequestSchema,
  operationsResearchRequestSchema,
} from '@forge/contracts/support-operations';
import { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { invalid, noQuery, strictBody, zValidator } from '../middleware/zod-validator.js';
import { requiresNoPermission, requiresOnParam } from '../permissions/index.js';
import { mountChannelRoutes } from './channel-routes.js';
import { postAsMaster } from './master-post.js';
import { ownerGitCredential } from './owner-git.js';
import { mountOwnerRoutes } from './owner-routes.js';

export { ownerSignInCallbackRoutes } from './owner-routes.js';

import { mountPromiseRoutes } from './promise-routes.js';
import { supportActionsOf, supportRoomsOf } from './read.js';
import { act, SESSION_ONLY } from './session-door.js';
import { supportTurnsOf } from './turns.js';

/**
 * A support group's and an operations room's doors (REQ-75). The session's acts, under
 * `/support/session/*`, admit only the room's own session holding its current turn's token
 * (`access.ts`); the reads admit a project reader.
 */
export const supportRoutes = new Hono<{ Variables: AuthVars }>();

// what every support door was held to while other project routers' `use('*')` gates ran ahead of
// these (ISS-925): a credential, and a verified email for a person; `agent-roles` is this router's too
for (const path of ['/:id/support/*', '/:id/agent-roles']) {
  supportRoutes.use(path, requireAuth(), assertEmailVerified());
}

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

/**
 * A channel agent answering several groups names the group of an act that names no thread of it
 * (the channel record, an announcement) with `?rid=` (REQ-77).
 */
const ridQuery = zValidator(
  'query',
  z.object({ rid: z.string().min(1).max(200).optional() }),
  invalid('invalid query: rid is a Rocket.Chat group id'),
);

/** A project document read: the group as `rid`, and a project the agent follows as `project` (ISS-874). */
const ridProjectQuery = zValidator(
  'query',
  z.strictObject({
    rid: z.string().min(1).max(200).optional(),
    project: supportProjectSlugSchema.optional(),
  }),
  invalid('invalid query: rid is a Rocket.Chat group id, project a project slug you follow'),
);

const SHAPES = {
  search: '{ query, project? }',
  thread: '{ thread }',
  reply: '{ thread, text }',
  run: '{ thread, tool, args? }',
  fix: '{ thread, tool, args?, asker }',
  record:
    '{ thread, kind: defect | feature | request, title, summary, whereSeen?, asker?, project? }',
  agree: '{ thread, proposal, message, decision?: agree | decline }',
  link: '{ thread, member }',
  issues: '{ project, status?, key? }',
  releases: '{ project }',
  requirements: '{ project }',
  move: '{ thread, issue, to, reason?, project? }',
  requirementDraft: '{ thread, project, title, summary }',
  feedbackDraft:
    '{ thread, project, kind: defect | feature | request, title, summary, one of requirement | issue | screen }',
  research: '{ thread, url }',
  moveIssue: '{ thread, issue, to, reason? }',
  build: '{ thread, branch: feat/<slug> | fix/<slug>, title, summary }',
  deploy: '{ thread, target }',
  deployment: '{ target }',
  command: '{ thread, host, command }',
  read: '{ name, args?, thread?, check? }',
  member: '{ member, roles, askFor?, message }',
  rule: '{ thread, message, text }',
  commonIssue: '{ threads, question, answer, feedback? }',
  route: '{ thread, to: forge | technical | product, member?, title?, text }',
  announce: '{ text }',
  askOwner: '{ thread, question, record?, forgeQuestion?, opener? }',
  answerQuestion: '{ thread, forgeQuestion?, source | message, option? | answer? }',
  checkResult: '{ check, finding: string | null }',
  gitCredential: '{ host, path }',
  image: '{ message, n? }',
} as const;

supportRoutes.post(
  '/:id/support/session/search',
  projectParam,
  SESSION_ONLY,
  strictBody(supportSearchRequestSchema, SHAPES.search),
  (c) => act(c, c.req.valid('param').id, { action: 'search', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/thread',
  projectParam,
  SESSION_ONLY,
  strictBody(supportThreadRequestSchema, SHAPES.thread),
  (c) => act(c, c.req.valid('param').id, { action: 'thread', ...c.req.valid('json') }),
);
supportRoutes.get('/:id/support/session/tools', projectParam, SESSION_ONLY, noQuery, (c) =>
  act(c, c.req.valid('param').id, { action: 'tools' }),
);
supportRoutes.post(
  '/:id/support/session/replies',
  projectParam,
  SESSION_ONLY,
  strictBody(supportReplyRequestSchema, SHAPES.reply),
  (c) => act(c, c.req.valid('param').id, { action: 'reply', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/checks',
  projectParam,
  SESSION_ONLY,
  strictBody(supportRunRequestSchema, SHAPES.run),
  (c) => act(c, c.req.valid('param').id, { action: 'run', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/fixes',
  projectParam,
  SESSION_ONLY,
  strictBody(supportProposeFixRequestSchema, SHAPES.fix),
  (c) => act(c, c.req.valid('param').id, { action: 'propose_fix', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/records',
  projectParam,
  SESSION_ONLY,
  strictBody(supportRecordRequestSchema, SHAPES.record),
  (c) => act(c, c.req.valid('param').id, { action: 'record', ...c.req.valid('json') }),
);
// the person's plain answer to a proposal, cited by the session by its message id (ISS-845)
supportRoutes.post(
  '/:id/support/session/agreements',
  projectParam,
  SESSION_ONLY,
  strictBody(supportAgreeRequestSchema, SHAPES.agree),
  (c) => act(c, c.req.valid('param').id, { action: 'agree', ...c.req.valid('json') }),
);
// a member's chat account linked to their Forge user through the link page (ISS-845)
supportRoutes.post(
  '/:id/support/session/links',
  projectParam,
  SESSION_ONLY,
  strictBody(supportLinkRequestSchema, SHAPES.link),
  (c) => act(c, c.req.valid('param').id, { action: 'link', ...c.req.valid('json') }),
);

// a picture a member's message carries, fetched by core with the bot's credential (ISS-1010): its
// bytes as base64 with their type, the way an image attachment's read hands them
supportRoutes.post(
  '/:id/support/session/images',
  projectParam,
  SESSION_ONLY,
  strictBody(supportImageRequestSchema, SHAPES.image),
  (c) => act(c, c.req.valid('param').id, { action: 'image', ...c.req.valid('json') }),
);

// what a room's grant opens (REQ-75 r5 BC-27): each refused by name where the room is not granted it
supportRoutes.post(
  '/:id/support/session/issue-moves',
  projectParam,
  SESSION_ONLY,
  strictBody(supportMoveIssueRequestSchema, SHAPES.moveIssue),
  (c) => act(c, c.req.valid('param').id, { action: 'move_issue', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/builds',
  projectParam,
  SESSION_ONLY,
  strictBody(supportBuildRequestSchema, SHAPES.build),
  (c) => act(c, c.req.valid('param').id, { action: 'build', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/deploys',
  projectParam,
  SESSION_ONLY,
  strictBody(supportDeployRequestSchema, SHAPES.deploy),
  (c) => act(c, c.req.valid('param').id, { action: 'deploy', ...c.req.valid('json') }),
);
// the latest deployment record of a granted deploy target, read to watch a deploy (ISS-775)
supportRoutes.post(
  '/:id/support/session/deployments',
  projectParam,
  SESSION_ONLY,
  ridQuery,
  strictBody(supportDeploymentRequestSchema, SHAPES.deployment),
  (c) =>
    act(
      c,
      c.req.valid('param').id,
      { action: 'deployment', ...c.req.valid('json') },
      c.req.valid('query').rid,
    ),
);
supportRoutes.post(
  '/:id/support/session/commands',
  projectParam,
  SESSION_ONLY,
  strictBody(supportCommandRequestSchema, SHAPES.command),
  (c) => act(c, c.req.valid('param').id, { action: 'command', ...c.req.valid('json') }),
);
// a read the room's grant declares, run at once through the box with no shell (ISS-871)
supportRoutes.post(
  '/:id/support/session/reads',
  projectParam,
  requiresNoPermission(
    "only the room's own session, under its current turn's token, is admitted (support/access.ts), and the room's grant gates the read",
  ),
  ridQuery,
  strictBody(supportReadRequestSchema, SHAPES.read),
  (c) =>
    act(
      c,
      c.req.valid('param').id,
      { action: 'read', ...c.req.valid('json') },
      c.req.valid('query').rid,
    ),
);

// an operations room's acts (REQ-75 BC-20..BC-24): read the scope, move delivery, draft direction, research;
// a channel agent reads its own project through the same reads (ISS-844)
// the project document, read by a channel agent (ISS-775)
supportRoutes.get(
  '/:id/support/session/project',
  projectParam,
  SESSION_ONLY,
  ridProjectQuery,
  (c) => {
    const { rid, project } = c.req.valid('query');
    return act(c, c.req.valid('param').id, { action: 'project', project }, rid);
  },
);
supportRoutes.get('/:id/support/session/projects', projectParam, SESSION_ONLY, noQuery, (c) =>
  act(c, c.req.valid('param').id, { action: 'projects' }),
);
supportRoutes.post(
  '/:id/support/session/issues',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsIssuesRequestSchema, SHAPES.issues),
  (c) => act(c, c.req.valid('param').id, { action: 'issues', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/releases',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsReleasesRequestSchema, SHAPES.releases),
  (c) => act(c, c.req.valid('param').id, { action: 'releases', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/requirements',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsRequirementsRequestSchema, SHAPES.requirements),
  (c) => act(c, c.req.valid('param').id, { action: 'requirements', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/moves',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsMoveRequestSchema, SHAPES.move),
  (c) => act(c, c.req.valid('param').id, { action: 'move', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/requirement-drafts',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsDraftRequirementRequestSchema, SHAPES.requirementDraft),
  (c) => act(c, c.req.valid('param').id, { action: 'draft_requirement', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/feedback-drafts',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsDraftFeedbackRequestSchema, SHAPES.feedbackDraft),
  (c) => act(c, c.req.valid('param').id, { action: 'draft_feedback', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/research',
  projectParam,
  SESSION_ONLY,
  strictBody(operationsResearchRequestSchema, SHAPES.research),
  (c) => act(c, c.req.valid('param').id, { action: 'research', ...c.req.valid('json') }),
);

// a bound channel's record (REQ-75 r6 BC-30..BC-41), as the session writes it
supportRoutes.get('/:id/support/session/channel', projectParam, SESSION_ONLY, ridQuery, (c) => {
  const query = c.req.valid('query');
  return act(c, c.req.valid('param').id, { action: 'channel' }, query.rid);
});
supportRoutes.post(
  '/:id/support/session/members',
  projectParam,
  SESSION_ONLY,
  strictBody(supportMemberRequestSchema, SHAPES.member),
  (c) => act(c, c.req.valid('param').id, { action: 'member', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/rules',
  projectParam,
  SESSION_ONLY,
  strictBody(supportRuleRequestSchema, SHAPES.rule),
  (c) => act(c, c.req.valid('param').id, { action: 'rule', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/common-issues',
  projectParam,
  SESSION_ONLY,
  strictBody(supportCommonIssueRequestSchema, SHAPES.commonIssue),
  (c) => act(c, c.req.valid('param').id, { action: 'common_issue', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/routes',
  projectParam,
  SESSION_ONLY,
  strictBody(supportRouteRequestSchema, SHAPES.route),
  (c) => act(c, c.req.valid('param').id, { action: 'route', ...c.req.valid('json') }),
);
supportRoutes.post(
  '/:id/support/session/announcements',
  projectParam,
  SESSION_ONLY,
  ridQuery,
  strictBody(supportAnnounceRequestSchema, SHAPES.announce),
  (c) => {
    const query = c.req.valid('query');
    return act(
      c,
      c.req.valid('param').id,
      { action: 'announce', ...c.req.valid('json') },
      query.rid,
    );
  },
);

supportRoutes.post(
  '/:id/support/session/owner-questions',
  projectParam,
  SESSION_ONLY,
  strictBody(supportAskOwnerRequestSchema, SHAPES.askOwner),
  (c) => act(c, c.req.valid('param').id, { action: 'ask_owner', ...c.req.valid('json') }),
);

// a parked question handed to the channel agent, answered from the record or the owner's message (ISS-873)
supportRoutes.post(
  '/:id/support/session/question-answers',
  projectParam,
  requiresNoPermission(
    "only the room's own session, under its current turn's token, is admitted (support/access.ts), and only a question handed to that room is answered",
  ),
  strictBody(supportAnswerQuestionRequestSchema, SHAPES.answerQuestion),
  (c) => act(c, c.req.valid('param').id, { action: 'answer_question', ...c.req.valid('json') }),
);

supportRoutes.post(
  '/:id/support/session/check-results',
  projectParam,
  SESSION_ONLY,
  strictBody(supportCheckResultRequestSchema, SHAPES.checkResult),
  (c) => act(c, c.req.valid('param').id, { action: 'check_result', ...c.req.valid('json') }),
);

// an owner-mode channel agent's git and gh ask here for a credential to its own repository (ISS-765)
supportRoutes.post(
  '/:id/support/session/git-credential',
  projectParam,
  SESSION_ONLY,
  strictBody(supportGitCredentialRequestSchema, SHAPES.gitCredential),
  async (c) => {
    const projectId = c.req.valid('param').id;
    const out = await ownerGitCredential(
      { userId: c.get('userId'), tokenId: c.get('patTokenId'), projectId },
      c.req.valid('json'),
    );
    if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
    return c.json(out.value);
  },
);

// the project's master posts its own words in any room its project binds, as that room's bot: its
// daily review at the top level (ISS-862), a result in the asker's own thread (ISS-871), in a support,
// channel agent or operations room alike (ISS-943)
supportRoutes.post(
  '/:id/support/master-posts',
  projectParam,
  requiresOnParam('project.write', 'id'),
  strictBody(supportMasterPostRequestSchema, '{ text, rid?, thread?, attachments? }'),
  async (c) => {
    const out = await postAsMaster(
      { userId: c.get('userId'), projectId: c.req.valid('param').id },
      c.req.valid('json'),
    );
    if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
    return c.json(out.value, 201);
  },
);

mountChannelRoutes(supportRoutes);
mountPromiseRoutes(supportRoutes);
mountOwnerRoutes(supportRoutes);

const SUPPORT_READ = requiresOnParam('project.read', 'id');

supportRoutes.get('/:id/support/rooms', projectParam, SUPPORT_READ, noQuery, async (c) => {
  const rooms = await supportRoomsOf(c.get('userId'), c.req.valid('param').id);
  return c.json({ rooms });
});

// each room's turn, for the bar that says what runs on the project now (REQ-15 BC-10)
supportRoutes.get('/:id/support/turns', projectParam, SUPPORT_READ, noQuery, async (c) =>
  c.json(await supportTurnsOf(c.get('userId'), c.req.valid('param').id)),
);

supportRoutes.get(
  '/:id/support/rooms/:roomId/actions',
  roomParam,
  SUPPORT_READ,
  noQuery,
  async (c) => {
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
  },
);
