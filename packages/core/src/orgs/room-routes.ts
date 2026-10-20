/**
 * `GET /api/orgs/:orgId/rooms-without-a-project` — the rooms an organization holds that are about no
 * project any more, because every project an agent brought them is deleted (ISS-1229 r23). They are
 * listed nowhere else, since every other list is a project's, so this is where their opener or an
 * admin of the organization finds them to delete them.
 */

import { and, desc, eq, isNotNull, isNull, notExists, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { conversationParticipants, conversations } from '../db/schema-conversations.js';
import { assertOrgAccess, orgRoleAtLeast } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import {
  listRoomsWithoutAProject,
  orgRoomsParamSchema,
  roomWithoutAProjectSchema,
} from './room-routes-reference.js';

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

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
    const { role } = await assertOrgAccess(orgId, userId, 'member');

    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        shape: conversations.shape,
        archivedAt: conversations.archivedAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(
          // A room whose organization nothing recorded (0350 found none) is its opener's alone, and
          // shown to them under whichever organization they read.
          or(
            and(
              eq(conversations.orgId, orgId),
              orgRoleAtLeast(role, 'admin') ? undefined : eq(conversations.createdBy, userId),
            ),
            and(isNull(conversations.orgId), eq(conversations.createdBy, userId)),
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
