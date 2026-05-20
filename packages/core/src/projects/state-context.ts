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

// `partialRecord` (Zod v4) builds a partial mapped type: each enum key is
// optional, unknown keys are rejected. `z.record(z.enum(...), ...)` would
// require every key to be present, which is the wrong shape for a patch.
export const stateContextSchema = z
  .partialRecord(z.enum(jobTypes), stateContextEntrySchema)
  .optional();

// `z.record(z.enum(...), ...)` infers a fully-required mapped type. Wrap it
// in `Partial` so consumers can pass a single-state patch without TypeScript
// demanding every job type.
export type StateContext = Partial<NonNullable<z.infer<typeof stateContextSchema>>>;

// The merge accepts a slightly looser patch shape than the schema: entries
// may also be `null` (remove that state) or `undefined` (no-op for that key).
// Zod doesn't model the null-to-remove sentinel on per-state entries, so we
// widen here. The REST/MCP surfaces only expose the strict schema; this
// laxer type is for direct in-process callers.
export type StateContextPatch = {
  [K in keyof StateContext]?: StateContext[K] | null | undefined;
};

/**
 * Per-state merge. `patch` entries fully replace the entry at that state
 * (no deep merge of `blocks` / `modelOverride` / `budget`) — callers must
 * pass the full entry for the state they are updating. States that don't
 * appear in the patch are left untouched. Set an entry to `null` to remove
 * that state's config; pass `null` for the whole patch to wipe `stateContext`.
 */
export function mergeStateContext(
  existing: unknown,
  patch: StateContextPatch | null | undefined,
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
