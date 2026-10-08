// The shapes `releaseBatchRoutes` accepts, kept apart from the routes that read them so the router
// stays a list of routes. Each is parsed at the door and refused by name; none is a default.

import { z } from 'zod';
import { RELEASE_ATTEMPT_STAGES } from '../db/schema-release-ledger.js';
import { RANGE_COMMIT_LIMIT } from '../projects/repository-reader.js';

export const projectParamSchema = z.object({ projectId: z.uuid() });

/** A roster names each issue once; a uuid is one id in either letter case. */
export const rosterIdsSchema = z.array(z.uuid()).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        message: `issueIds names ${id} more than once, counting either letter case as the same id: send each issue once.`,
      });
      return;
    }
    seen.add(id.toLowerCase());
  }
});

export const createBodySchema = z
  .object({
    /** No size here: `collectReleaseBlockers` owns the limit and the empty gate (ISS-1127). */
    issueIds: rosterIdsSchema,
    /** The version of a FAILED release being cut again; `cutReleaseVersion` rules on its shape. */
    recutOf: z.string().trim().max(100).optional(),
    /** A decision for each issue the release's range carries off the roster (ISS-1386). */
    carried: z
      .array(
        z.discriminatedUnion('decision', [
          z
            .object({
              issueId: z.uuid(),
              decision: z.literal('ship-unverified'),
              why: z.string().trim().min(1, 'say what ships unverified').max(2000),
            })
            .strict(),
          z.object({ issueId: z.uuid(), decision: z.literal('revert') }).strict(),
          z.object({ issueId: z.uuid(), decision: z.literal('cut-below') }).strict(),
        ]),
      )
      .max(RANGE_COMMIT_LIMIT)
      .optional(),
  })
  .strict();

export const runParamSchema = z.object({ projectId: z.uuid(), runId: z.uuid() });

export const finishBodySchema = z
  .object({ commit: z.string().trim().max(200).optional() })
  .strict();
export const lookBodySchema = z.object({ commit: z.string().trim().max(200).optional() }).strict();
export const abortBodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
    /**
     * What to do with a roster whose run already promoted. Absent is `hold`, which is what this
     * door did before the choice existed (ISS-1199).
     */
    promotedRoster: z.enum(['hold', 'return-to-gate']).optional(),
  })
  .strict();

/**
 * `account` has a floor because it is the whole of Rule 2 of ISS-1129: a release performed by
 * hand and one performed by a batch are different facts, and "released" with no account of how
 * is a silent substitution. Twenty characters does not make an account good; it makes `ok` refused.
 */
export const releaseRecordBodySchema = z
  .object({
    issueIds: rosterIdsSchema.min(1),
    commit: z.string().trim().min(1).max(200),
    account: z.string().trim().min(20).max(20_000),
    providerRef: z.string().trim().max(500).optional(),
  })
  .strict();

export const attemptBodySchema = z
  .object({
    stage: z.enum(RELEASE_ATTEMPT_STAGES),
    idempotencyKey: z.string().trim().min(1).max(200),
    commit: z.string().trim().max(200).optional(),
  })
  .passthrough();

export const accountBodySchema = z
  .object({
    account: z.string().trim().min(1).max(20_000),
    providerRef: z.string().trim().max(500).optional(),
    logTail: z.string().max(200_000).optional(),
  })
  .passthrough();

export const methodBodySchema = z
  .object({
    skill: z.string().trim().min(1).max(200),
    loaded: z.boolean(),
    detail: z.string().trim().max(4_000).optional(),
  })
  .strict();

export const attemptKeyParamSchema = z.object({
  projectId: z.uuid(),
  runId: z.uuid(),
  key: z.string().trim().min(1).max(200),
});
