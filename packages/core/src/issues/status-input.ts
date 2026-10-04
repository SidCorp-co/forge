import { isLegacyIssueStatus, issueStatusLegacyRefusal } from '@forge/contracts/issue-vocabulary';
import { RefusalError } from '../lib/refusal.js';

/**
 * Called from a validator hook on a failed parse, with the raw input it was given: every legacy
 * name in `fields` is refused as one `ISSUE_STATUS_LEGACY` envelope, so a legacy name is answered
 * by its own code rather than as a shape error. A field may hold one value or a list.
 */
export function refuseLegacyStatusFields(
  input: unknown,
  target: 'json' | 'query',
  fields: readonly string[],
): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const refusals = fields.flatMap((field) => {
    const raw = record[field];
    const values = Array.isArray(raw) ? raw : [raw];
    return values.flatMap((value) =>
      typeof value === 'string' && isLegacyIssueStatus(value)
        ? [issueStatusLegacyRefusal(value, target === 'json' ? `/${field}` : field)]
        : [],
    );
  });
  if (refusals.length > 0) throw new RefusalError(refusals, 'ISSUE_STATUS_LEGACY');
}
