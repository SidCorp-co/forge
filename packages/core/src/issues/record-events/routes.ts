// `POST /api/issues/:id/events` writes a typed record; `GET` reads an issue's records (ISS-56).

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { messageRefusalHttp } from '../../comments/screen.js';
import { db } from '../../db/client.js';
import { issues } from '../../db/schema.js';
import { loadProjectAccess } from '../../lib/authz.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import type { Actor } from '../../pipeline/activity.js';
import { isRecordEventKind, RECORD_DIGEST_KIND, RECORD_EVENT_KINDS } from './kinds.js';
import { listRecordEvents, type RecordEvent, RecordEventRefused } from './store.js';
import { writeScreenedRecordEvent } from './write.js';
import { requireHeld } from '../../permissions/index.js';

/** Shape only: the kind, contract and fields are judged by `assertRecordEventDraft`, by name. */
const eventBodySchema = z
  .object({
    kind: z.string().max(64),
    contract: z.number(),
    fields: z.array(z.object({ key: z.string().max(64), value: z.string() }).strict()),
  })
  .strict();

const listQuerySchema = z
  .object({
    kind: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(1000).optional(),
  })
  .strict();

/** The wire shape of one event: what `@forge/contracts` `RecordEventView` declares. */
export function serializeRecordEvent(event: RecordEvent) {
  return { ...event, createdAt: event.createdAt.toISOString() };
}

function refusalHttp(err: unknown): HTTPException | null {
  if (err instanceof RecordEventRefused) {
    return new HTTPException(422, { message: err.message, cause: { code: err.code } });
  }
  return messageRefusalHttp(err);
}

async function loadIssueForEvents(
  issueId: string,
  userId: string,
  permission: 'project.read' | 'project.write',
) {
  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) throw notFound('issue not found');
  const access = await loadProjectAccess(issue.projectId, userId);
  requireHeld(access, permission);
  return issue;
}

export const recordEventRoutes = new Hono<{ Variables: AuthVars }>();
recordEventRoutes.use('/:id/events', requireAuth(), assertEmailVerified());

recordEventRoutes.post(
  '/:id/events',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', eventBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const draft = c.req.valid('json');
    const issue = await loadIssueForEvents(id, c.get('userId'), 'project.write');
    const deviceId = c.get('patDeviceId') ?? null;
    const actor: Actor = deviceId
      ? { type: 'device', id: deviceId, agency: 'agent' }
      : restActor(c);
    try {
      const event = await writeScreenedRecordEvent({
        projectId: issue.projectId,
        issueId: issue.id,
        actor,
        ...draft,
      });
      return c.json(serializeRecordEvent(event), 201);
    } catch (err) {
      const refusal = refusalHttp(err);
      if (refusal) throw refusal;
      throw err;
    }
  },
);

recordEventRoutes.get(
  '/:id/events',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { kind, limit } = c.req.valid('query');
    if (kind !== undefined && kind !== RECORD_DIGEST_KIND && !isRecordEventKind(kind)) {
      throw new HTTPException(422, {
        message: `\`${kind}\` is not a record kind — filter by one of: ${[...RECORD_EVENT_KINDS, RECORD_DIGEST_KIND].join(', ')}`,
        cause: { code: 'EVENT_KIND_UNKNOWN' },
      });
    }
    const issue = await loadIssueForEvents(id, c.get('userId'), 'project.read');
    const events = await listRecordEvents(issue.id, {
      ...(kind ? { kinds: [kind as RecordEvent['kind']] } : {}),
      ...(limit ? { limit } : {}),
    });
    return c.json({ items: events.map(serializeRecordEvent) });
  },
);
