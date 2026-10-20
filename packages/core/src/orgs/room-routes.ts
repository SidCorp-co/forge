/**
 * `GET /api/orgs/:orgId/rooms-without-a-project` — the rooms an organization holds that are about no
 * project any more, because every project an agent brought them is deleted (ISS-1229 r23). They are
 * listed nowhere else, since every other list is a project's, so this is where their opener or an
 * admin of the organization finds them, reads them and deletes them. Each row says which project went,
 * when the room was opened and when it was last spoken in, so rooms with one title are told apart.
 */

import { and, desc, eq, isNotNull, isNull, max, notExists, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { organizationMembers } from '../db/schema.js';
import {
  conversationMessages,
  conversationParticipants,
  conversations,
} from '../db/schema-conversations.js';
import { assertOrgAccess, orgRoleAtLeast } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import {
  listRoomsWithoutAProject,
  orgRoomsParamSchema,
  roomWithoutAProjectSchema,
} from './room-routes-reference.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

export const orgRoomRoutes = new Hono<{ Variables: AuthVars }>();

orgRoomRoutes.get(
  '/:orgId/rooms-without-a-project',
  listRoomsWithoutAProject,
  zValidator('param', orgRoomsParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const userId = c.get('userId');
    const { role, isPersonal } = await assertOrgAccess(orgId, userId, 'member');
    // A personal workspace is its owner's alone, and the one scope a room no organization holds for
    // its opener belongs to (ISS-1229 r24), so it is never listed under every organization they read.
    const ownWorkspace = isPersonal && role === 'owner';
    const lastSaid = db
      .select({
        conversationId: conversationMessages.conversationId,
        at: max(conversationMessages.createdAt).as('at'),
      })
      .from(conversationMessages)
      .groupBy(conversationMessages.conversationId)
      .as('last_said');

    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        shape: conversations.shape,
        archivedAt: conversations.archivedAt,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        deletedProjectNames: conversations.deletedProjectNames,
        lastMessageAt: lastSaid.at,
      })
      .from(conversations)
      .leftJoin(lastSaid, eq(lastSaid.conversationId, conversations.id))
      .where(
        and(
          // A room whose organization nothing recorded (0350 found none), or one the opener no longer
          // belongs to, is its opener's alone, shown under their personal workspace.
          or(
            and(
              eq(conversations.orgId, orgId),
              orgRoleAtLeast(role, 'admin') ? undefined : eq(conversations.createdBy, userId),
            ),
            and(
              ownWorkspace ? undefined : sql`false`,
              eq(conversations.createdBy, userId),
              or(
                isNull(conversations.orgId),
                notExists(
                  db
                    .select({ userId: organizationMembers.userId })
                    .from(organizationMembers)
                    .where(
                      and(
                        eq(organizationMembers.orgId, conversations.orgId),
                        eq(organizationMembers.userId, userId),
                      ),
                    ),
                ),
              ),
            ),
          ),
          notExists(
            db
              .select({ id: conversationParticipants.id })
              .from(conversationParticipants)
              .where(
                and(
                  eq(conversationParticipants.conversationId, conversations.id),
                  eq(conversationParticipants.kind, 'handle'),
                  isNull(conversationParticipants.removedAt),
                  isNotNull(conversationParticipants.projectId),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(conversations.updatedAt));

    return c.json(answer(z.array(roomWithoutAProjectSchema), rows));
  },
);
