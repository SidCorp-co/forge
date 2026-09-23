/**
 * Two routes whose unit is the whole backlog (ISS-1173), each answering in one streamed call.
 *
 * These are the first production routes here to emit `text/event-stream`. The fan-out they do is
 * in-process on purpose: `middleware/rate-limit.ts:rateLimit` charges once at middleware entry and
 * knows nothing of what the handler does afterwards, so one request is one tick however many
 * searches or pages it reads. Looping back through `fetch` to a rate-limited route would charge
 * once per iteration, which is the collision this issue exists to end.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { RULES } from '../../config/rate-limits.js';
import { type IssueStatus, issueStatuses } from '../../db/schema.js';
import { assertProjectAccess } from '../../lib/authz.js';
import { queryBadRequest } from '../../lib/query-strict.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { alikeSource } from './alike-source.js';
import { Cancellation } from './cancellation.js';
import { emitBacklogStream } from './emitter.js';
import { orderingSource } from './ordering-source.js';
import { countMatching } from './page-read.js';

/** What `forge next` calls takeable: the statuses a run may claim work from. */
export const TAKEABLE_STATUSES: IssueStatus[] = ['open', 'confirmed', 'approved', 'reopen'].filter(
  (s): s is IssueStatus => (issueStatuses as readonly string[]).includes(s),
);

/** What `forge alike` calls open: everything the tracker has not settled. */
export const UNSETTLED_STATUSES: IssueStatus[] = issueStatuses.filter(
  (s) => s !== 'closed' && s !== 'dropped',
);

const LIMIT_MIN = 1;
const LIMIT_MAX = 5_000;
const BUDGET_MIN_MS = 1_000;
const BUDGET_MAX_MS = 600_000;
const TOP_K_MIN = 1;
const TOP_K_MAX = 50;

const idParamSchema = z.object({ id: z.uuid() });

/** A repeated `status=` and a comma-separated one mean the same thing; an unknown one is refused. */
const statusList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')))
  .pipe(
    z
      .array(
        z.enum(issueStatuses, {
          error: `each status must be one of: ${issueStatuses.join(', ')}`,
        }),
      )
      .min(1, { error: 'status must name at least one status' }),
  );

const limitField = z.coerce
  .number()
  .int()
  .min(LIMIT_MIN, { error: `limit must be between ${LIMIT_MIN} and ${LIMIT_MAX}` })
  .max(LIMIT_MAX, { error: `limit must be between ${LIMIT_MIN} and ${LIMIT_MAX}` })
  .default(1_000);

const budgetField = z.coerce
  .number()
  .int()
  .min(BUDGET_MIN_MS, { error: `budgetMs must be between ${BUDGET_MIN_MS} and ${BUDGET_MAX_MS}` })
  .max(BUDGET_MAX_MS, { error: `budgetMs must be between ${BUDGET_MIN_MS} and ${BUDGET_MAX_MS}` })
  .default(300_000);

const orderingQuerySchema = z
  .object({
    status: statusList.optional(),
    limit: limitField,
    body: z
      .enum(['true', 'false'], { error: 'body must be true or false' })
      .default('false')
      .transform((v) => v === 'true'),
    budgetMs: budgetField,
  })
  .strict();

const alikeQuerySchema = z
  .object({
    status: statusList.optional(),
    topK: z.coerce
      .number()
      .int()
      .min(TOP_K_MIN, { error: `topK must be between ${TOP_K_MIN} and ${TOP_K_MAX}` })
      .max(TOP_K_MAX, { error: `topK must be between ${TOP_K_MIN} and ${TOP_K_MAX}` })
      .default(10),
    limit: limitField,
    budgetMs: budgetField,
  })
  .strict();

/** The module's surface to the composition root: what it mounts, and what winds it down. */
export { closeBacklogStreams } from './open-streams.js';

export const backlogStreamRoutes = new Hono<{ Variables: AuthVars }>();

backlogStreamRoutes.use(
  '/:id/backlog/*',
  requireAuth(),
  assertEmailVerified(),
  rateLimit(RULES.backlogStream, { name: 'backlog-stream' }),
);

/** Cloudflare sits in front of production and nothing in this repo owns its buffering settings. */
function streamHeaders(c: { header: (k: string, v: string) => void }): void {
  c.header('X-Accel-Buffering', 'no');
}

backlogStreamRoutes.get(
  '/:id/backlog/ordering',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw queryBadRequest(idParamSchema, r.error);
  }),
  zValidator('query', orderingQuerySchema, (r) => {
    if (!r.success) throw queryBadRequest(orderingQuerySchema, r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const q = c.req.valid('query');
    await assertProjectAccess(id, c.get('userId'), 'viewer');

    const statuses = q.status ?? TAKEABLE_STATUSES;
    const total = await countMatching(id, statuses);
    const cancellation = new Cancellation();
    streamHeaders(c);
    return streamSSE(c, async (stream) => {
      await emitBacklogStream(c, stream, {
        kind: 'ordering',
        projectId: id,
        total,
        limit: q.limit,
        budgetMs: q.budgetMs,
        cancellation,
        source: orderingSource({ projectId: id, statuses, withBody: q.body, cancellation }),
      });
    });
  },
);

backlogStreamRoutes.get(
  '/:id/backlog/alike',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw queryBadRequest(idParamSchema, r.error);
  }),
  zValidator('query', alikeQuerySchema, (r) => {
    if (!r.success) throw queryBadRequest(alikeQuerySchema, r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const q = c.req.valid('query');
    await assertProjectAccess(id, c.get('userId'), 'viewer');

    const statuses = q.status ?? UNSETTLED_STATUSES;
    const total = await countMatching(id, statuses);
    const cancellation = new Cancellation();
    streamHeaders(c);
    return streamSSE(c, async (stream) => {
      await emitBacklogStream(c, stream, {
        kind: 'alike',
        projectId: id,
        total,
        limit: q.limit,
        budgetMs: q.budgetMs,
        cancellation,
        source: alikeSource({ projectId: id, statuses, topK: q.topK, cancellation }),
      });
    });
  },
);
