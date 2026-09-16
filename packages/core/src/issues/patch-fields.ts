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
  onChange?.('description', updates.description);
  onChange?.('descriptionFormat', updates.descriptionFormat);
  return { updates, warnings: prepared?.warnings ?? [] };
}

function readFormat(value: unknown): 'markdown' | 'html' | undefined {
  return value === 'markdown' || value === 'html' ? value : undefined;
}
