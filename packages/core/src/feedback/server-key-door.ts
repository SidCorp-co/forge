/**
 * The door a product server reaches Feedback through with its server key (ISS-922). Mounted ahead of
 * every `/api/projects` router, it answers `POST /api/projects/:id/feedback` and
 * `GET /api/projects/:id/feedback/:fb` itself when the bearer is a server key, and passes every other
 * request on untouched. The key is resolved here and never becomes a session: no `userId`, no
 * principal and no agency is set on the request, so no later gate or handler runs under it. Anywhere
 * else a server key is presented, `middleware/bearer.ts` refuses it by name before any gate reads it.
 *
 * Filing runs `service.ts:fileFeedback`, the same value check, dedup and insert a person's filing
 * runs, as the product's own account (`server-keys.ts`), member of nothing, so the item's reporter is
 * the product. The answer names the item and the reporter.
 *
 * Reading (ISS-1287) answers where an item the product filed stands, its phase and its row's chip,
 * read by `read.ts:filedReadOf`, the reader the project's own feedback page reads it with, and on a
 * declined item the reason its decline wrote for the reporter (ISS-1412). An item another reporter
 * filed is refused `FEEDBACK_SERVER_KEY_NOT_ITS_FILING`; nothing else is read back.
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
  type FeedbackServerKeyReadResponse,
  feedbackServerKeyReadResponseSchema,
} from '@forge/contracts/feedback-server-keys';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { refused } from '../lib/refusal.js';
import { readServerKeyBearer, serverKeyScopeRefusal } from '../middleware/bearer.js';
import { declaredResponse } from '../middleware/declared-response.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { strictBody } from '../middleware/zod-validator.js';
import { filedReadOf, rowIn } from './read.js';
import { filedFeedbackKey, serverKeyClosed, serverKeyOf, touchServerKey } from './server-keys.js';
import { fileFeedback } from './service.js';

const HOUR_MS = 60 * 60_000;

const uuid = z.uuid();

const bodyCheck = strictBody(createFeedbackRequestSchema, CREATE_FEEDBACK_SHAPE);

const doorAnswer = (status: 401 | 403 | 429, code: string, message: string, retryAfter?: number) =>
  new HTTPException(status, {
    message,
    cause: retryAfter === undefined ? { code } : { code, retryAfter },
  });

type Key = NonNullable<Awaited<ReturnType<typeof serverKeyOf>>>;

/** The key a secret names, open and of this request's project; refused by name otherwise. */
async function openKeyOn(c: Context, token: string, now: Date): Promise<Key> {
  const projectId = c.req.param('id') ?? '';
  const key = await serverKeyOf(token);
  if (!key) {
    throw doorAnswer(401, 'FEEDBACK_SERVER_KEY_UNKNOWN', 'no server key matches this secret');
  }
  const closed = serverKeyClosed(key, now);
  if (closed === 'revoked') {
    throw doorAnswer(401, 'FEEDBACK_SERVER_KEY_REVOKED', `server key ${key.prefix}… was revoked`);
  }
  if (closed === 'expired') {
    throw doorAnswer(401, 'FEEDBACK_SERVER_KEY_EXPIRED', `server key ${key.prefix}… has expired`);
  }
  if (!uuid.safeParse(projectId).success || projectId !== key.projectId) {
    throw serverKeyScopeRefusal(
      `server key ${key.prefix}… files and reads on its own project only, and this is another`,
    );
  }
  return key;
}

/** The request's body, checked by the same validator the person's route mounts. */
async function checkedBody(c: Context): Promise<CreateFeedbackRequest> {
  let body: CreateFeedbackRequest | undefined;
  await bodyCheck(c, async () => {
    body = c.req.valid('json' as never);
  });
  if (!body) throw new Error('feedback server key: the body validator passed without a body');
  return body;
}

async function fileWithServerKey(c: Context, token: string): Promise<Response> {
  const now = new Date();
  const key = await openKeyOn(c, token, now);
  const request = await checkedBody(c);
  const limit = await consumeRateLimit(
    `feedbackServerKey:key:${key.id}`,
    FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR,
    HOUR_MS,
  );
  if (!limit.allowed) {
    throw doorAnswer(
      429,
      'FEEDBACK_SERVER_KEY_RATE_LIMITED',
      `server key ${key.prefix}… has filed ${FEEDBACK_SERVER_KEY_FILINGS_PER_HOUR} items this hour; nothing was filed`,
      Math.max(1, Math.ceil(limit.resetMs / 1000)),
    );
  }
  const filed = await fileFeedback({
    projectId: key.projectId,
    actor: { userId: key.accountId, agency: 'agent' },
    request,
  });
  if (!filed.ok) return refused(c, filed.refusals, 'FEEDBACK_REFUSED');
  await touchServerKey(key.id, now);
  const body: FeedbackServerKeyFiledResponse = {
    feedback: { key: await filedFeedbackKey(filed.id), created: filed.created },
    reporter: { kind: 'product', product: key.product },
  };
  return c.json(body, filed.created ? 201 : 200);
}

async function readWithServerKey(c: Context, token: string, ref: string): Promise<Response> {
  const now = new Date();
  const key = await openKeyOn(c, token, now);
  const row = await rowIn(db, key.projectId, ref);
  // every key of one product names the same account, so a re-minted key reads what the old one filed
  if (row.reportedBy !== key.accountId) {
    throw doorAnswer(
      403,
      'FEEDBACK_SERVER_KEY_NOT_ITS_FILING',
      `${feedbackKey(row.fbSeq)} was filed by another reporter; server key ${key.prefix}… reads only the items ${key.product} filed`,
    );
  }
  const { summary, declineReason, declineReasonWithheld } = await filedReadOf(
    { userId: key.accountId, agency: 'agent' },
    row,
  );
  await touchServerKey(key.id, now);
  const body: FeedbackServerKeyReadResponse = {
    feedback: {
      key: summary.key,
      phase: summary.phase,
      chip: summary.chip,
      declineReason,
      declineReasonWithheld,
    },
  };
  return c.json(body);
}

const ADMITS = `a server key admits POST on its project's feedback and GET of one item it filed`;

export const feedbackServerKeyDoor = new Hono();

feedbackServerKeyDoor.use('/:id/feedback', async (c, next) => {
  const token = readServerKeyBearer(c);
  if (token === null) return next();
  if (c.req.method !== 'POST')
    throw serverKeyScopeRefusal(`${ADMITS}, never ${c.req.method} on the list`);
  return fileWithServerKey(c, token);
});

// one segment only: `…/feedback/:fb/similar` and the like pass on, and `bearer.ts` refuses them; the
// published contract carries the read's answer, so a product can pin the version that has its fields
feedbackServerKeyDoor.use(
  '/:id/feedback/:fb',
  declaredResponse({
    method: 'GET',
    status: 200,
    under: 'a feedback server key (Authorization: Bearer fsk_…), on an item its product filed',
    description:
      'where the item stands, its phase and its row chip as the project feedback page reads them, and on a declined item the reason its decline wrote for the reporter (ISS-1287, ISS-1412).',
    schema: feedbackServerKeyReadResponseSchema,
  }),
  async (c, next) => {
    const token = readServerKeyBearer(c);
    if (token === null) return next();
    const ref = c.req.param('fb') ?? '';
    if (c.req.method !== 'GET' || !/^(?:FB-)?\d{1,9}$/i.test(ref)) {
      throw serverKeyScopeRefusal(
        `${ADMITS} by its key (FB-n); ${c.req.method} ${c.req.path} is not that`,
      );
    }
    return readWithServerKey(c, token, ref);
  },
);
