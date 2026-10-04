import { ApiError } from './client';

const FRIENDLY_CODES: Record<string, string> = {
  UNAUTHENTICATED: 'Your session has expired. Please sign in again.',
  INVALID_TOKEN: 'Your session is invalid. Please sign in again.',
  FORBIDDEN: 'You do not have access to this resource.',
  ADMIN_ONLY: 'Admin access required.',
  EMAIL_NOT_VERIFIED: 'Please verify your email before continuing.',
  NOT_FOUND: 'Not found.',
  BAD_REQUEST: 'Invalid input — please check the fields and try again.',
  CONFLICT: 'Conflicts with the current state of the resource.',
  ILLEGAL_TRANSITION: 'That status change is not allowed from the current state.',
  STALE_TRANSITION: 'Someone else changed this item while you were editing — refresh and retry.',
  NO_OP: 'Already in that state.',
  NOT_IMPLEMENTED: 'This action is not implemented yet.',
  INVALID_CREDENTIALS: 'Email or password is incorrect.',
  SLUG_TAKEN: 'That slug is already taken.',
  ASSIGNEE_NOT_MEMBER: 'Assignee must be a project member.',
  INVALID_LABELS: 'One or more labels do not belong to this project.',
  LABEL_NAME_TAKEN: 'A label with that name already exists in this project.',
  LABEL_IN_USE: 'Issues are still tagged with this — remove it from them first.',
  INVALID_PARENT: 'That parent is not a label in this project.',
  PARENT_NOT_MODULE: 'A module’s parent has to be a module.',
  PARENT_ON_NON_MODULE: 'Only a module can have a parent.',
  CIRCULAR_HIERARCHY: 'That parent sits under this module — pick one above it.',
  MODULE_IN_USE: 'Other modules or issues still depend on this one.',
  PRIMARY_NOT_MODULE: 'Only a module can be an issue’s primary.',
  MULTIPLE_PRIMARY: 'An issue has at most one primary module.',
  NO_MODULES: 'This project has no modules yet — create one to draw its diagrams.',
  NO_MODULE_FLOWS: 'No module stores a flow yet — add a mermaid block to a module’s knowledge node.',
  UNPARSABLE_MODULE_FLOW: 'A module stores a flow this generator cannot read.',
};

/** ISS-1160 — a screen offers Retry only where retrying could change the answer.
 *  A 4xx is the same request meeting the same refusal again; only a network
 *  failure or a 5xx is worth resubmitting. */
export function isRetryableApiError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status >= 500;
  return true;
}

/**
 * ISS-1327 — the merge-mark refusals in the web's own words. Core's sentence is written for
 * agents and names every door there is; a person here has one, the issue's Mark merged control.
 * Read off `details`, never parsed out of the prose.
 */
function detailStr(details: unknown, key: string): string | null {
  const value = details && typeof details === 'object' ? (details as Record<string, unknown>)[key] : null;
  return typeof value === 'string' ? value : null;
}

function mergeMarkSentence(err: ApiError): string | null {
  if (err.code === 'CLOSE_REQUIRES_SHIPPED') {
    if (detailStr(err.details, 'requires') !== 'mergedLanding') {
      return 'Nothing on this issue says the work shipped, so it cannot close. Once it has, use Mark merged in the issue’s properties, then close. Use Dropped for work that turned out not to be work.';
    }
    const unmarkFirst =
      detailStr(err.details, 'held') === 'asserted'
        ? 'Its mark names no landing, so press Unmark first, then '
        : 'Use ';
    return `Nothing on this issue says where the work landed, so it cannot close. ${unmarkFirst}Mark merged in the issue’s properties and fill in “Where it landed” — the live URL, CMS entry or storefront resource — then close. Use Dropped if it never landed.`;
  }
  if (err.code === 'MARK_ALREADY_STANDS') {
    return 'This issue already carries a mark, and that mark stands — nothing changed. To change it, press Unmark, then Mark merged with the landing that is right.';
  }
  return null;
}

export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const mergeMark = mergeMarkSentence(err);
    if (mergeMark) return mergeMark;
    if (err.code && FRIENDLY_CODES[err.code]) return FRIENDLY_CODES[err.code];
    if (err.message) return err.message;
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}


/** A refusal said by its name: the code core refused with, then the sentence. */
export function formatRefusal(err: unknown): string {
  const sentence = formatApiError(err);
  return err instanceof ApiError && err.code ? `${err.code}: ${sentence}` : sentence;
}
