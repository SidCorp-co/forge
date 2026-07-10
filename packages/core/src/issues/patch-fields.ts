/**
 * SSOT for the plain (no-side-effect) issue patch fields shared by the two
 * update surfaces — REST `PATCH /api/issues/:id` (issues/routes.ts) and MCP
 * `forge_issues.update` (mcp/tools/forge-issues.ts). Both previously
 * hand-maintained their own `if (x !== undefined)` ladders, so adding an
 * issue column meant editing ≥2 whitelists or silently diverging.
 *
 * Fields with per-surface guards/side effects stay OUT of these lists and
 * live at their call site: REST-only `assigneeId` (member check),
 * `metadata` (branch self-reference guard), `labels` (label tx +
 * activity); MCP `status` (routes through the transition state machine).
 *
 * Known intentional drift (do NOT "fix" casually): REST emits the
 * `issueUpdated` hook with before/after tracking; MCP update does not.
 */

export const SHARED_ISSUE_PATCH_FIELDS = [
  'title',
  'description',
  'priority',
  'category',
  'complexity',
  'plan',
  'acceptanceCriteria',
  'suggestedSolution',
  'releaseNotes',
] as const;

/** Agent-facing fields accepted only by the MCP update surface. */
export const MCP_ONLY_ISSUE_PATCH_FIELDS = [
  'sessionContext',
  'aiSummary',
  'aiSuggestedSolution',
  'aiAcceptanceCriteria',
  'aiConfidence',
] as const;

/**
 * Copy every defined field from `patch` into a fresh updates object,
 * invoking `onChange` per copied field for surface-specific bookkeeping
 * (REST uses it for before/after change tracking).
 */
export function collectIssueFieldUpdates(
  patch: Record<string, unknown>,
  fields: readonly string[],
  onChange?: (field: string, next: unknown) => void,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const field of fields) {
    const next = patch[field];
    if (next !== undefined) {
      updates[field] = next;
      onChange?.(field, next);
    }
  }
  return updates;
}
