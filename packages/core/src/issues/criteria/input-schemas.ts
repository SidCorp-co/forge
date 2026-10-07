// ISS-55 — the wire shapes of the criteria and verdict writes, shared by REST and MCP. The verdict
// word is a free string here on purpose: an unknown one is refused by name by
// `verdict-input.ts:verdictDraftFault` (VERDICT_VALUE_UNKNOWN), not by a schema's generic 400.

import { REASON_TEXT_MAX } from '@forge/contracts/comments';
import { storefrontDraftIdentitySchema } from '@forge/contracts/verdict-identity';
import { z } from 'zod';
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
  .object({ criteria: z.array(criterionItem).max(200) })
  .strict()
  .transform(({ criteria }) => ({ criteria: numberCriteria(criteria) }));

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

export const verdictPostSchema = z
  .object({
    criterion: z.number().int().min(1),
    verdict: z.string().trim().min(1).max(32),
    reason: z.string().trim().max(REASON_TEXT_MAX).nullable().optional(),
    identity: verdictIdentitySchema.nullable().optional(),
    evidence: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  })
  .strict();
