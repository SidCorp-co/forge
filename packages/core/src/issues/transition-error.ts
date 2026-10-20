export type TransitionErrorCode =
  | 'NO_OP'
  | 'ILLEGAL_TRANSITION'
  | 'TRANSITION_REASON_REQUIRED'
  | 'WAITING_KIND_REQUIRED'
  | 'STALE_TRANSITION'
  | 'NO_WORK_EVIDENCE'
  | 'RELEASE_RECORD_REQUIRED'
  | 'ENTRY_CRITERIA_UNMET'
  | 'CLOSE_REQUIRES_SHIPPED'
  | 'CLOSE_REQUIRES_RELEASE_TAG'
  | 'RELEASE_TAG_UNREAD'
  | 'RELEASE_TARGET_UNDECLARED'
  | 'WAITING_KIND_NOT_APPLICABLE'
  | 'ISSUE_ARCHIVED'
  | 'OPEN_QUESTIONS'
  | 'VOID_REASON_REQUIRED'
  | 'RELEASING_STARTS_FROM_RELEASE'
  | 'RELEASING_ENDS_BY_RELEASE';

/** `details.steps`, a record's key to its whole step, as one line each under the sentence. */
function stepLines(steps: unknown): string {
  if (!steps || typeof steps !== 'object') return '';
  return Object.entries(steps)
    .map(([key, step]) => `\n${key}: ${String(step)}`)
    .join('');
}

/**
 * Typed transition failure. `message` keeps the legacy `CODE: detail` shape
 * the MCP surface exposes, with each of `details.steps` on a line of its own, since an MCP
 * caller reads no details; REST callers map `code`/`detail`/`details` onto
 * HTTPException instead of parsing the string.
 */
export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    readonly detail: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${detail}${stepLines(details.steps)}`);
  }
}
