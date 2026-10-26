/**
 * The two reads of the maintained indexes (ISS-1336): the ordering of the takeable issues and the
 * nearest issues of every unsettled one. Both are plain JSON, one call each, and both answer from
 * stored rows, so unlike the ISS-1173 streams they have no budget to run out of.
 *
 * They are mounted on the streams' router (`routes.ts`) so one middleware stack, one rate-limit
 * charge and one authorization answer for the whole `/:id/backlog/*` surface.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import { answer } from '../../api-reference/declare/describe.js';
import { zValidator } from '../../api-reference/declare/validator.js';
import { assertProjectAccess } from '../../lib/authz.js';
import { queryBadRequest } from '../../lib/query-strict.js';
import type { AuthVars } from '../../middleware/auth.js';
import {
  ALIKE_TOP_K,
  NEIGHBOURS_LIMIT_DEFAULT,
  NEIGHBOURS_LIMIT_MAX,
  readNeighbours,
} from './alike-read.js';
import {
  neighboursSchema,
  rankingSchema,
  readNeighboursRoute,
  readRankingRoute,
} from './index-routes-reference.js';
import { RANKING_LIMIT_DEFAULT, RANKING_LIMIT_MAX, readRanking } from './rank-read.js';

/** What a read spends catching up the pending set before it answers, unless the caller says otherwise. */
export const CATCH_UP_DEFAULT_MS = 5_000;
export const CATCH_UP_MAX_MS = 30_000;

const idParamSchema = z.object({ id: z.uuid() });

const flag = (name: string) =>
  z
    .enum(['true', 'false'], { error: `${name} must be true or false` })
    .default('false')
    .transform((v) => v === 'true');

const catchUpField = z.coerce
  .number()
  .int()
  .min(0, { error: `catchUpMs must be between 0 and ${CATCH_UP_MAX_MS}` })
  .max(CATCH_UP_MAX_MS, { error: `catchUpMs must be between 0 and ${CATCH_UP_MAX_MS}` })
  .default(CATCH_UP_DEFAULT_MS);

const rankingQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1, { error: `limit must be between 1 and ${RANKING_LIMIT_MAX}` })
      .max(RANKING_LIMIT_MAX, { error: `limit must be between 1 and ${RANKING_LIMIT_MAX}` })
      .default(RANKING_LIMIT_DEFAULT),
    eligible: flag('eligible'),
    catchUpMs: catchUpField,
  })
  .strict();

const neighboursQuerySchema = z
  .object({
    topK: z.coerce
      .number()
      .int()
      .min(1, { error: `topK must be between 1 and ${ALIKE_TOP_K}` })
      .max(ALIKE_TOP_K, {
        error: `topK must be between 1 and ${ALIKE_TOP_K}: that is how many neighbours an issue keeps`,
      })
      .default(ALIKE_TOP_K),
    limit: z.coerce
      .number()
      .int()
      .min(1, { error: `limit must be between 1 and ${NEIGHBOURS_LIMIT_MAX}` })
      .max(NEIGHBOURS_LIMIT_MAX, { error: `limit must be between 1 and ${NEIGHBOURS_LIMIT_MAX}` })
      .default(NEIGHBOURS_LIMIT_DEFAULT),
    after: z.coerce
      .number()
      .int()
      .min(0, { error: 'after must be an issue sequence number, 0 or more' })
      .default(0),
    catchUpMs: catchUpField,
  })
  .strict();

export function registerBacklogIndexRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.get(
    '/:id/backlog/ranking',
    readRankingRoute,
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw queryBadRequest(idParamSchema, r.error);
    }),
    zValidator('query', rankingQuerySchema, (r) => {
      if (!r.success) throw queryBadRequest(rankingQuerySchema, r.error);
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const q = c.req.valid('query');
      await assertProjectAccess(id, c.get('userId'), 'viewer', 'read its backlog');
      return c.json(
        answer(
          rankingSchema,
          await readRanking({
            projectId: id,
            limit: q.limit,
            eligibleOnly: q.eligible,
            catchUpMs: q.catchUpMs,
          }),
        ),
      );
    },
  );

  router.get(
    '/:id/backlog/neighbours',
    readNeighboursRoute,
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw queryBadRequest(idParamSchema, r.error);
    }),
    zValidator('query', neighboursQuerySchema, (r) => {
      if (!r.success) throw queryBadRequest(neighboursQuerySchema, r.error);
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const q = c.req.valid('query');
      await assertProjectAccess(id, c.get('userId'), 'viewer', 'read its backlog');
      return c.json(
        answer(
          neighboursSchema,
          await readNeighbours({
            projectId: id,
            topK: q.topK,
            limit: q.limit,
            after: q.after,
            catchUpMs: q.catchUpMs,
          }),
        ),
      );
    },
  );
}
