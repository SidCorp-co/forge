/**
 * The door a product server files Feedback through with its server key (ISS-922). Mounted ahead of
 * every `/api/projects` router, it answers `POST /api/projects/:id/feedback` itself when the bearer
 * is a server key, and passes every other request on untouched. The key is resolved here and never
 * becomes a session: no `userId`, no principal and no agency is set on the request, so no later gate
 * or handler runs under it. Anywhere else a server key is presented, `middleware/bearer.ts` refuses
 * it by name before any gate reads it.
 *
 * Filing runs `service.ts:fileFeedback`, the same value check, dedup and insert a person's filing
 * runs, as the product's own account (`server-keys.ts`), member of nothing, so the item's reporter is
 * the product. The answer names the item and the reporter, and reads nothing back.
 */

import {
  CREATE_FEEDBACK_SHAPE,
  type CreateFeedbackRequest,
  createFeedbackRequestSchema,
  feedbackKey,
} from '@forge/contracts/feedback';
import {
  FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR,
  type FeedbackServerKeyFiledResponse,
} from '@forge/contracts/feedback-server-keys';
import { eq } from 'drizzle-orm';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { refused } from '../lib/refusal.js';
import { readServerKeyBearer, serverKeyScopeRefusal } from '../middleware/bearer.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { strictBody } from '../middleware/zod-validator.js';
import { serverKeyClosed, serverKeyOf, touchServerKey } from './server-keys.js';
import { fileFeedback } from './service.js';

const HOUR_MS = 60 * 60_000;

const uuid = z.uuid();

const bodyCheck = strictBody(createFeedbackRequestSchema, CREATE_FEEDBACK_SHAPE);

const doorAnswer = (status: 401 | 429, code: string, message: string) =>
  new HTTPException(status, { message, cause: { code } });

/** The request's body, checked by the same validator the person's route mounts. */
async function checkedBody(c: Context): Promise<CreateFeedbackRequest> {
  let body: CreateFeedbackRequest | undefined;
  await (bodyCheck as unknown as MiddlewareHandler)(c, async () => {
    body = (c.req as unknown as { valid: (t: 'json') => CreateFeedbackRequest }).valid('json');
  });
  if (!body) throw new Error('feedback server key: the body validator passed without a body');
  return body;
}

async function fileWithServerKey(c: Context, token: string): Promise<Response> {
  const projectId = c.req.param('id') ?? '';
  const key = await serverKeyOf(token);
  if (!key) {
    throw doorAnswer(401, 'FEEDBACK_SERVER_KEY_UNKNOWN', 'no server key matches this secret');
  }
  const now = new Date();
  const closed = serverKeyClosed(key, now);
  if (closed === 'revoked') {
    throw doorAnswer(401, 'FEEDBACK_SERVER_KEY_REVOKED', `server key ${key.prefix}… was revoked`);
  }
  if (closed === 'expired') {
    throw doorAnswer(401, 'FEEDBACK_SERVER_KEY_EXPIRED', `server key ${key.prefix}… has expired`);
  }
  if (!uuid.safeParse(projectId).success || projectId !== key.projectId) {
    throw serverKeyScopeRefusal(
      `server key ${key.prefix}… files on its own project only, and this is another`,
    );
  }
  const request = await checkedBody(c);
  const limit = await consumeRateLimit(
    `feedbackServerKey:key:${key.id}`,
    FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR,
    HOUR_MS,
  );
  if (!limit.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(limit.resetMs / 1000))));
    throw doorAnswer(
      429,
      'FEEDBACK_SERVER_KEY_RATE_LIMITED',
      `server key ${key.prefix}… has filed ${FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR} items this hour; nothing was filed`,
    );
  }
  const filed = await fileFeedback({
    projectId,
    actor: { userId: key.accountId, agency: 'agent' },
    request,
  });
  if (!filed.ok) return refused(c, filed.refusals, 'FEEDBACK_REFUSED');
  await touchServerKey(key.id, now);
  const [row] = await db
    .select({ seq: feedback.fbSeq })
    .from(feedback)
    .where(eq(feedback.id, filed.id));
  const body: FeedbackServerKeyFiledResponse = {
    feedback: { key: feedbackKey(row?.seq ?? 0), created: filed.created },
    reporter: { kind: 'product', product: key.product },
  };
  return c.json(body, filed.created ? 201 : 200);
}

export const feedbackServerKeyDoor = new Hono();

feedbackServerKeyDoor.use('/:id/feedback', async (c, next) => {
  const token = readServerKeyBearer(c);
  if (token === null) return next();
  if (c.req.method !== 'POST') {
    throw serverKeyScopeRefusal(
      `a server key admits POST on its project's feedback only, never ${c.req.method}`,
    );
  }
  return fileWithServerKey(c, token);
});
