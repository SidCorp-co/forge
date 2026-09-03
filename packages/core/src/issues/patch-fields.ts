/**
 * SSOT for the plain (no-side-effect) issue patch fields shared by the two
 * update surfaces — REST `PATCH /api/issues/:id` (issues/routes.ts) and MCP
 * `forge_issues.update` (mcp/tools/forge-issues.ts). Both previously
 * hand-maintained their own `if (x !== undefined)` ladders, so adding an
 * issue column meant editing ≥2 whitelists or silently diverging.
 *
 * Fields with per-surface guards/side effects stay OUT of this list and
 * live at their call site: REST-only `assigneeId` (member check),
 * `metadata` (branch self-reference guard), `labels` (label tx +
 * activity); MCP `status` (routes through the transition state machine).
 *
 * There is no MCP-only set any more. `sessionContext` and `detectorKey` were
 * in one until the CLI had to write them over REST; both surfaces now validate
 * them the same way (`issues/session-context.ts`, `issues/detector-key.ts`).
 *
 * Known intentional drift (do NOT "fix" casually): REST emits the
 * `issueUpdated` hook with before/after tracking; MCP update does not.
 */

import { prepareBody } from '../body/prepare.js';

export const SHARED_ISSUE_PATCH_FIELDS = [
  'title',
  'description',
  'priority',
  'category',
  'complexity',
  'plan',
  'acceptanceCriteria',
  'releaseNotes',
  'sessionContext',
  // cm:why lets an existing issue adopt a detector's key so the next run lands on it instead of opening a rival; the partial unique index rejects the write if another live issue already holds that key
  'detectorKey',
] as const;

export interface CollectedIssueFieldUpdates {
  updates: Record<string, unknown>;
  /** What the body sanitizer removed, for the transport to hand back. */
  warnings: string[];
}

/**
 * Copy every defined field from `patch` into a fresh updates object,
 * invoking `onChange` per copied field for surface-specific bookkeeping
 * (REST uses it for before/after change tracking).
 */
// cm:guard ISS-898 — the description body is validated HERE, not at the two transports, because this function IS the convergence point they share; validating at one of them is validating at neither. It returns `warnings` rather than swallowing them so a caller who typed `<div>` learns it was unwrapped. `descriptionFormat` is read off the raw patch, never from `fields`, so it can never be written to the row unvalidated.
export function collectIssueFieldUpdates(
  patch: Record<string, unknown>,
  fields: readonly string[],
  onChange?: (field: string, next: unknown) => void,
): CollectedIssueFieldUpdates {
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    const next = patch[field];
    if (next === undefined) continue;
    updates[field] = next;
    // cm:why `description` skips the callback here and fires it below with the PREPARED body — the activity log's `after` must be the bytes that were stored, not the bytes that were sent, or the feed records a value the row never held
    if (field !== 'description') onChange?.(field, next);
  }
  if (updates.description === undefined) return { updates, warnings: [] };

  const raw = updates.description;
  const empty = typeof raw !== 'string' || raw.trim().length === 0;
  const prepared = empty
    ? null
    : prepareBody({ raw: raw as string, format: readFormat(patch.descriptionFormat) });
  updates.description = prepared ? prepared.body : raw;
  updates.descriptionFormat = prepared?.format ?? 'markdown';
  updates.descriptionTemplate = prepared?.template ?? null;
  onChange?.('description', updates.description);
  // cm:edge contract -> packages/core/src/memory/indexer.ts — the `issueUpdated` hook carries only CHANGED fields, and the indexer needs the format alongside the body to project it; unreported, an html description is re-embedded as raw markup on every edit
  onChange?.('descriptionFormat', updates.descriptionFormat);
  return { updates, warnings: prepared?.warnings ?? [] };
}

function readFormat(value: unknown): 'markdown' | 'html' | undefined {
  return value === 'markdown' || value === 'html' ? value : undefined;
}
