// ISS-55 — the wire shapes of the criteria and verdict writes, shared by REST and MCP. The verdict
// word is a free string here on purpose: an unknown one is refused by name by
// `verdict-input.ts:verdictDraftFault` (VERDICT_VALUE_UNKNOWN), not by a schema's generic 400.

import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import { criterionProbeSchema } from '@forge/contracts/criterion-probes';
import { CRITERION_JUDGES, ISSUE_CRITERIA_MAX } from '@forge/contracts/issue-design';
import { storefrontDraftIdentitySchema } from '@forge/contracts/verdict-identity';
import { z } from 'zod';
import { criterionLeadingNumber } from '../../messaging/criterion-named.js';
import type { CriterionInput } from './store.js';

const criterionItem = z
  .object({
    n: z.number().int().min(1).optional(),
    statement: z.string().trim().min(1).max(10_000),
    requirementCriterionId: z.uuid().nullable().optional(),
  })
  .strict();

/** Give every criterion sent without a number the next one after the highest sent. */
function numberCriteria(items: ReadonlyArray<z.infer<typeof criterionItem>>): CriterionInput[] {
  let next = Math.max(0, ...items.map((c) => c.n ?? 0)) + 1;
  return items.map((c) => ({
    n: c.n ?? next++,
    statement: c.statement,
    requirementCriterionId: c.requirementCriterionId,
  }));
}

export const criteriaPutSchema = z
  .object({ criteria: z.array(criterionItem).max(ISSUE_CRITERIA_MAX) })
  .strict()
  .transform(({ criteria }) => ({ criteria: numberCriteria(criteria) }));

/** One criterion of an issue, named by its number on the issue or by its id. */
export const criterionParamSchema = z.object({
  id: z.uuid(),
  ref: z.union([
    z.uuid().transform((id) => ({ id })),
    z
      .string()
      .regex(/^[1-9][0-9]{0,5}$/, 'a criterion number or id')
      .transform((n) => ({ n: Number(n) })),
  ]),
});

/** One criterion's corrected wording and why: its id, and so its verdicts, are kept (`criterion-reword.ts`). */
export const criterionPatchSchema = z
  .object({
    statement: z.string().trim().min(1).max(10_000),
    reason: z.string().trim().min(1).max(REASON_TEXT_MAX),
  })
  .strict();

/** The business criteria to tie an issue to, by code; a code of the wrong shape is refused by name. */
export const criteriaTracePostSchema = z
  .object({ codes: z.array(z.string().trim().min(1).max(32)).min(1).max(50) })
  .strict();

const verdictIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), sha: z.string().trim().min(1).max(64) }).strict(),
  z.object({ kind: z.literal('runtime'), ref: z.string().trim().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('design'),
      workflow: z.string().trim().min(1).max(200),
      revision: z.number().int(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('contract'),
      ref: z.string().trim().min(1).max(300),
      version: z.string().trim().min(1).max(100),
    })
    .strict(),
  storefrontDraftIdentitySchema,
]);

/**
 * One repository path prefix a verdict's criterion rests on (ISS-845): relative to the repository's
 * root and `/`-separated, as a changed file is named. A pass carried to a later landing does not carry
 * where a file changed between the two falls under one.
 */
const coversPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'), {
    message:
      'a covers entry is a path prefix relative to the repository root, such as `packages/core/src/issues/`: no leading `/`, no `..`, no `\\`',
  });

export const verdictPostSchema = z
  .object({
    /**
     * The criterion's number, or its exact line as the issue holds it (`messaging/criterion-named.ts`).
     * A number leading a label names that number, so the label, never read, has no length cap.
     */
    criterion: z.union([
      z.number().int().min(1),
      z
        .string()
        .trim()
        .min(1)
        .refine((text) => text.length <= 2000 || criterionLeadingNumber(text) !== null, {
          message:
            'a criterion named by its line is at most 2000 characters; name it by its number, or by its number leading the line',
        }),
    ]),
    verdict: z.string().trim().min(1).max(32),
    reason: z.string().trim().max(REASON_TEXT_MAX).nullable().optional(),
    identity: verdictIdentitySchema.nullable().optional(),
    evidence: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    /** The path prefixes the criterion rests on; omitted, a pass carries on descent alone (ISS-845). */
    covers: z
      .array(coversPrefixSchema)
      .min(1, 'covers names at least one path prefix; omit it where the criterion rests on none')
      .max(100)
      .optional(),
    /** Recorded as QA's judgement of the running build (the default) or as the review's. */
    judge: z.enum(CRITERION_JUDGES).optional(),
    /** The probe this verdict keeps on its criterion: what it runs against the build and expects. */
    probe: criterionProbeSchema.optional(),
    /** Why a judgement of an observable criterion cites no screen clip (REQ-40 BC-4). */
    withoutClip: z.string().trim().min(1).max(REASON_TEXT_MAX).optional(),
    /** The run recording it, on a box whose runs share one credential: the box's run id, or core's session or run id (ISS-475). */
    run: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
