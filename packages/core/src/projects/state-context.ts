import { z } from 'zod';
import { jobTypes } from '../db/schema.js';

// Per-state token-budget shape (W2.3.1). Values are persisted under
// `projects.agentConfig.stateContext[state].budget` and consumed by later
// waves (W2.3.2 pre-dispatch cap, W2.3.3 in-flight kill). No enforcement
// lives here — this module is pure validation + merge.
export const budgetSchema = z
  .object({
    perRunUsd: z.number().nonnegative().max(1000),
    perMonthUsd: z.number().nonnegative().max(100_000),
    action: z.enum(['warn', 'pause']),
  })
  .strict();

export type StateBudget = z.infer<typeof budgetSchema>;

// One entry per pipeline state. `blocks` and `modelOverride` are already
// used informally elsewhere in the codebase; declaring them here keeps the
// `stateContext` surface validated as a whole rather than per-field.
export const stateContextEntrySchema = z
  .object({
    blocks: z.record(z.string(), z.unknown()).optional(),
    modelOverride: z.string().min(1).max(200).nullable().optional(),
    budget: budgetSchema.optional(),
  })
  .strict();

export type StateContextEntry = z.infer<typeof stateContextEntrySchema>;

// cm:why `partialRecord` over `z.record(z.enum(...))`: the latter demands every jobType be present, which is the wrong shape for a patch
// cm:guard the entry is `.nullable()` because `null` is `mergeStateContext`'s REMOVAL SENTINEL, and a schema that refuses it leaves every REST/MCP caller with no way to delete one jobType — the whole map or nothing. ISS-814: web-v2's editor sent exactly `{ triage: null }` and got a 400 naming a shape the merge below documents as supported.
export const stateContextSchema = z
  .partialRecord(z.enum(jobTypes), stateContextEntrySchema.nullable())
  .optional();

export type StateContext = Partial<NonNullable<z.infer<typeof stateContextSchema>>>;

/**
 * Per-state merge. `patch` entries fully replace the entry at that state
 * (no deep merge of `blocks` / `modelOverride` / `budget`) — callers must
 * pass the full entry for the state they are updating. States that don't
 * appear in the patch are left untouched. Set an entry to `null` to remove
 * that state's config; pass `null` for the whole patch to wipe `stateContext`.
 */
export function mergeStateContext(
  existing: unknown,
  patch: StateContext | null | undefined,
): Record<string, unknown> | null {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  if (patch === null) return null;
  if (patch === undefined) return base;
  for (const [state, entry] of Object.entries(patch)) {
    if (entry === null || entry === undefined) {
      delete base[state];
    } else {
      base[state] = entry;
    }
  }
  return base;
}
