// `/api/conversations` — the durable rooms, read by the scope they derive.
//
// Replaces `/api/chat/sessions`, whose list was "rows carrying this project id
// and this user id". A conversation carries neither, so the list is the rooms
// this project's handle speaks in, filtered to the ones the caller's roles
// reach.
//
// It lives HERE, beside the rest of the assistant, rather than under
// `conversations/`, because it is the Forge UI's own adapter and not part of the
// store: it opens `web` venues, which is what being that adapter means, and a
// store that knows one transport's name knows them all. `transport-free.test.ts`
// is the gate that keeps the store clean, and this file is what it would have
// had to carve an exception for.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  type ConversationRow,
  conversationAgentUnavailableReason,
  deleteConversation,
  derivedScope,
  listConversationsInProject,
  listParticipants,
  mayChangeMembership,
  projectsNamed,
  readableConversation,
  renameConversation,
  setConversationArchived,
  setConversationPresence,
  validateRoomPresence,
  writableConversation,
} from '../conversations/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { fromPage, listResponse } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, can, projectResource, requireHeld } from '../permissions/index.js';
import { batchesOfConversation } from '../questionnaires/index.js';
import { agentModeOffer } from './conversation-agent-offer.js';
import { conversationAttachmentRoutes } from './conversation-attachment-routes.js';
import { conversationMemberRoutes } from './conversation-member-routes.js';
import { conversationMessageRoutes } from './conversation-message-routes.js';
import { withDisplayNames } from './conversation-people.js';
import {
  conversationPinRoutes,
  conversationScopeSchema,
  ecosystemOfScope,
  scopeIsFixed,
} from './conversation-scope.js';
import { pinnedBy, roomTail } from './read.js';
import { openWebConversation } from './service.js';
import { threadMarks } from './thread-marks.js';

const archivedQuery = z
  .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')], {
    error: "archived takes '1', '0', 'true' or 'false'",
  })
  .optional()
  .transform((v) => v === '1' || v === 'true');

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    /** `1`/`true` lists ONLY the archived rooms; anything else lists only the live ones. */
    archived: archivedQuery,
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    title: z.string().max(500).nullable().optional(),
    /** Colleagues to open the room with, beside whoever is opening it. */
    people: z.array(z.uuid()).max(50).optional(),
    /** Agents to open the room with, beside the opening project's own. */
    handles: z
      .array(z.object({ projectId: z.uuid(), userId: z.uuid().optional() }).strict())
      .max(20)
      .optional(),
    scope: conversationScopeSchema.optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
    presence: z.record(z.string(), z.unknown()).nullable().optional(),
    scope: z.unknown().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.title !== undefined ||
      v.archived !== undefined ||
      v.presence !== undefined ||
      v.scope !== undefined,
    {
      error:
        'a PATCH body must carry `title` (a string or null), `archived` (a boolean) or `presence` (an object or null)',
    },
  );

export const conversationRoutes = new Hono<{ Variables: AuthVars }>();
conversationRoutes.use('*', requireAuth(), assertEmailVerified());

conversationRoutes.route('/', conversationMemberRoutes);
conversationRoutes.route('/', conversationAttachmentRoutes);
conversationRoutes.route('/', conversationPinRoutes);
conversationRoutes.route('/', conversationMessageRoutes);

conversationRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { projectId, page, pageSize, archived } = c.req.valid('query');
  const userId = c.get('userId');

  const access = await loadProjectAccess(projectId, userId);
  requireHeld(access, 'project.read');

  const rows = await listConversationsInProject(projectId, { archived });
  const pinned = await pinnedBy(
    userId,
    rows.map((r) => r.id),
  );

  const roleByProject = new Map<string, boolean>();
  const visible: ConversationRow[] = [];
  for (const row of rows) {
    const scope = await derivedScope(row.id);
    let ok = scope.length > 0;
    for (const pid of scope) {
      let held = roleByProject.get(pid);
      if (held === undefined) {
        held = await can(actorFor(userId), 'project.read', projectResource(pid));
        roleByProject.set(pid, held);
      }
      if (!held) ok = false;
    }
    if (ok && row.shape === 'direct') {
      const people = await listParticipants(row.id);
      ok = people.some((p) => p.kind === 'person' && p.userId === userId);
    }
    if (ok) visible.push({ ...row, pinned: pinned.has(row.id) } as ConversationRow);
  }

  const offset = (page - 1) * pageSize;
  const pageRows = visible.slice(offset, offset + pageSize);
  const marks = await threadMarks(pageRows, userId);
  return c.json(
    listResponse(
      c,
      pageRows.map((r) => ({
        ...r,
        ...(marks.get(r.id) ?? { kind: null, threadStatus: null, subjectKey: null }),
      })),
      visible.length,
      fromPage(page, pageSize),
    ),
  );
});

/**
 * Whether a NEW conversation in this project could be opened in Agent mode.
 */
conversationRoutes.get(
  '/agent-mode',
  zValidator('query', z.object({ projectId: z.uuid() }).strict()),
  async (c) => {
    const { projectId } = c.req.valid('query');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.read');
    const unavailable = await conversationAgentUnavailableReason(projectId);
    return c.json({ available: unavailable === null, reason: unavailable });
  },
);

conversationRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const input = c.req.valid('json');
  const userId = c.get('userId');

  const access = await loadProjectAccess(input.projectId, userId);
  requireHeld(access, 'project.write');

  const handles = input.handles ?? [];
  const people = input.people ?? [];
  const ecosystemId = await ecosystemOfScope(input.projectId, input.scope);

  const conversation = await openWebConversation({
    projectId: input.projectId,
    title: input.title ?? null,
    ecosystemId,
    userId,
    handles,
    people,
  });

  return c.json(conversation, 201);
});

conversationRoutes.get('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  const conversation = await readableConversation(id, userId);
  const [participants, { messages, windows, agentTurns }, scope, questionnaires, marks] =
    await Promise.all([
      listParticipants(id),
      roomTail(id, userId),
      derivedScope(id),
      batchesOfConversation(id),
      threadMarks([conversation], userId),
    ]);
  const scopeProjects = await projectsNamed(scope);
  return c.json({
    ...conversation,
    scope,
    scopeProjects,
    canChangeMembership: await mayChangeMembership(conversation, userId),
    agentMode: await agentModeOffer(conversation, scope, messages.length),
    agentTurns,
    participants: await withDisplayNames(participants),
    messages,
    windows,
    // a questionnaire block names its batch; the batches ride the detail read so the card
    // shows its live state and answers with the same socket invalidation as the messages
    questionnaires,
    ...(marks.get(id) ?? { kind: null, threadStatus: null, subjectKey: null }),
  });
});

conversationRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', patchSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { title, archived, presence, scope } = c.req.valid('json');
    const userId = c.get('userId');
    await writableConversation(id, userId);
    if (scope !== undefined) throw scopeIsFixed(id);
    let roomPresence: ReturnType<typeof validateRoomPresence> | null | undefined;
    if (presence !== undefined) {
      roomPresence = presence === null ? null : validateRoomPresence(presence);
    }
    let updated: ConversationRow | null = null;
    if (title !== undefined) updated = await renameConversation(id, title);
    if (archived !== undefined) updated = await setConversationArchived(id, archived);
    if (roomPresence !== undefined) updated = await setConversationPresence(id, roomPresence);
    if (!updated) throw notFound('conversation not found');
    return c.json(updated);
  },
);

conversationRoutes.delete('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');
  await writableConversation(id, userId);
  await deleteConversation(id);
  return c.body(null, 204);
});
