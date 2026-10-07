import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import { ANSWER_VIEWS } from '@forge/contracts/projection';
import type { Context } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import type { RequirementActor } from './read.js';
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

export const revisionFields = {
  reason: z.string().max(REASON_TEXT_MAX),
  spec: specSchema.optional(),
  tldr: z.string().max(4_000).nullable().optional(),
  changeSummary: z.string().max(4_000).nullable().optional(),
  criteria: z.array(criterionSchema).max(200),
};

export function actorOf(c: Context<RequirementEnv>): RequirementActor {
  const agency = c.get('agency');
  if (!agency) throw new Error('requirements: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

export function answer(c: Context, outcome: RequirementOutcome) {
  if (!outcome.ok) return refused(c, outcome.refusals, 'REQUIREMENT_REFUSED');
  return c.json(outcome.requirement, outcome.created ? 201 : 200);
}
