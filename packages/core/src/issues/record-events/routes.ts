// `POST /api/issues/:id/events` writes a typed record; `GET` reads an issue's records (ISS-56).

import {
  isRecordEventKind,
  RECORD_DIGEST_KIND,
  RECORD_EVENT_KINDS,
  type RecordEventRefusalCode,
} from '@forge/contracts/record-events';
import { Hono } from 'hono';
import { z } from 'zod';
import { loadProjectAccess } from '../../lib/authz.js';
import { refuser } from '../../lib/refusal.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
} from '../../middleware/auth.js';
import { badRequest, idParamSchema, notFound } from '../../middleware/route-errors.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { requireHeld } from '../../permissions/index.js';
import type { Actor } from '../activity.js';
import { messageRefusalHttp } from '../ports.js';
import { issueScopeOf } from '../read-service.js';
import { listRecordEvents, type RecordEvent } from './store.js';
import { writeScreenedRecordEvent } from './write.js';

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

async function loadIssueForEvents(
  issueId: string,
  userId: string,
  permission: 'project.read' | 'project.write',
) {
  const issue = await issueScopeOf(issueId);
  if (!issue) throw notFound('issue not found');
  const access = await loadProjectAccess(issue.projectId, userId);
  requireHeld(access, permission);
  return { id: issue.id, projectId: issue.projectId };
}

const refuseEvent = refuser<RecordEventRefusalCode>('EVENT_REFUSED');

export const recordEventRoutes = new Hono<{ Variables: AuthVars }>();
recordEventRoutes.use('/:id/events', requireAuth(), assertEmailVerified());

recordEventRoutes.post(
  '/:id/events',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', eventBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
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
      const refusal = messageRefusalHttp(err);
      if (refusal) throw refusal;
      throw err;
    }
  },
);

recordEventRoutes.get(
  '/:id/events',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { kind, limit } = c.req.valid('query');
    if (kind !== undefined && kind !== RECORD_DIGEST_KIND && !isRecordEventKind(kind)) {
      throw refuseEvent(
        'EVENT_KIND_UNKNOWN',
        `\`${kind}\` is not a record kind — filter by one of: ${[...RECORD_EVENT_KINDS, RECORD_DIGEST_KIND].join(', ')}`,
        '/kind',
      );
    }
    const issue = await loadIssueForEvents(id, c.get('userId'), 'project.read');
    const events = await listRecordEvents(issue.id, {
      ...(kind ? { kinds: [kind as RecordEvent['kind']] } : {}),
      ...(limit ? { limit } : {}),
    });
    return c.json({ items: events.map(serializeRecordEvent) });
  },
);
