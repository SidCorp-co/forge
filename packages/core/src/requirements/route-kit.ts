import { DECISION_MAKERS, DECISION_MAKERS_SHAPE, REASON_TEXT_MAX } from '@forge/contracts/comments';
import { ANSWER_VIEWS } from '@forge/contracts/projection';
import {
  type DraftPicture,
  draftPictureSchema,
  type RequirementKind,
  revisionKindField,
} from '@forge/contracts/requirement-pictures';
import { writtenLangSchema } from '@forge/contracts/written-lang';
import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { draftPictureRefusals, landingIn, NEW_REQUIREMENT } from './draft-picture.js';
import { type RequirementActor, rowIn } from './read.js';
import { criterionSchema, specSchema } from './schemas.js';
import type { RequirementOutcome } from './write-tx.js';

export type RequirementEnv = { Variables: AuthVars };

const reqRef = z.string().trim().min(1).max(64);

/** A path validator whose failure is a 400 naming the path's shape. */
function pathParams<T extends z.ZodRawShape>(shape: T, expected: string) {
  return zValidator('param', z.object(shape), invalid(`invalid path: ${expected}`));
}

export const projectParam = pathParams({ id: z.uuid() }, 'the project id is a uuid');

export const reqParam = pathParams(
  { id: z.uuid(), req: reqRef },
  'a project uuid and a requirement uuid or key',
);

export const revisionParam = pathParams(
  { id: z.uuid(), req: reqRef, n: z.coerce.number().int().min(1) },
  'a project uuid, a requirement and a revision number',
);

export const reqAnd = <T extends z.ZodRawShape>(shape: T, expected: string) =>
  pathParams({ id: z.uuid(), req: reqRef, ...shape }, `a project uuid, a requirement${expected}`);

export const viewQuery = zValidator(
  'query',
  z.strictObject({ view: z.enum(ANSWER_VIEWS).optional() }),
  invalid('invalid query: view? (summary | full, full by default)'),
);

export const decisionsQuery = zValidator(
  'query',
  z.strictObject({ by: z.enum(DECISION_MAKERS).optional() }),
  invalid(`invalid query: ${DECISION_MAKERS_SHAPE}`),
);

export const revisionFields = {
  reason: z.string().max(REASON_TEXT_MAX),
  spec: specSchema.optional(),
  kind: revisionKindField,
  picture: draftPictureSchema.optional(),
  tldr: z.string().max(4_000).nullable().optional(),
  changeSummary: z.string().max(4_000).nullable().optional(),
  criteria: z.array(criterionSchema).max(200),
  writtenLang: writtenLangSchema.optional(),
};

/**
 * A draft's picture judged where its body arrives, after the body's validator and before a chat's
 * hold (REQ-35 BC-10): a held draft is never offered on a card whose press would only be refused for
 * its picture. `onto` is where the write lands: a new requirement, or a new revision on the head.
 * The write judges it again in its own transaction.
 */
export function draftPictureFits(onto: 'new' | 'head'): MiddlewareHandler<RequirementEnv> {
  return async (c, next) => {
    const body = (c.req.valid as (target: 'json') => unknown)('json') as {
      kind?: RequirementKind | null;
      picture?: DraftPicture;
    };
    if (!body.picture) return next();
    const { id, req } = c.req.param() as { id: string; req?: string };
    await requireCan(actorFor(c.get('userId')), 'project.write', projectResource(id));
    const landing =
      onto === 'head' && req
        ? await rowIn(db, id, req).then((row) =>
            landingIn(db, row.id, { head: row.currentRevision }),
          )
        : NEW_REQUIREMENT;
    const unfit = draftPictureRefusals(landing, body, false);
    if (unfit.length) return refused(c, unfit, 'REQUIREMENT_REFUSED');
    return next();
  };
}

export function actorOf(c: Context<RequirementEnv>): RequirementActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('requirements: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

export function answer(c: Context, outcome: RequirementOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'REQUIREMENT_REFUSED');
  return c.json(outcome.requirement, outcome.created ? 201 : 200);
}
