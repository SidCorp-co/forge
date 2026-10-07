// Who may move a requirement across the release line, and why: a defer and the undefer that undoes
// it, each refused by name (ISS-85).

import { DEFERRABLE_STATUSES } from '@forge/contracts/requirements';
import type { RequirementStatus } from '../db/schema-requirements.js';
import { deferredRefusal, type RequirementRefusal } from './rules.js';

// A defer is a person's act with a reason, from draft or agreed only, and never while a
// linked issue is in work: those are dropped, unlinked or left at draft first, each one named
export function deferRefusals(input: {
  status: RequirementStatus;
  reason: string | null | undefined;
  workingIssues: readonly string[];
}): RequirementRefusal[] {
  const out: RequirementRefusal[] = [];
  const deferred = deferredRefusal(input.status, 'deferring it again');
  if (deferred) return [deferred];
  if (!(DEFERRABLE_STATUSES as readonly string[]).includes(input.status)) {
    out.push({
      code: 'REQUIREMENT_NOT_DEFERRABLE',
      path: '',
      detail: `the requirement is ${input.status}; only a draft or agreed requirement is deferred out of the current release.`,
    });
  }
  if (!input.reason?.trim()) {
    out.push({
      code: 'REQUIREMENT_DEFER_REASON_REQUIRED',
      path: '/reason',
      detail:
        'a deferred requirement says why it left the current release, so nobody re-proposes it.',
    });
  }
  if (input.workingIssues.length) {
    out.push({
      code: 'REQUIREMENT_HAS_LIVE_ISSUES',
      path: '',
      detail: `linked issues are past draft and not closed: ${input.workingIssues.join(', ')}; drop or unlink them, or leave them at draft, before the requirement leaves the release.`,
    });
  }
  return out;
}

// An undefer is a person's act with a reason, as the defer it undoes is: both say why the
// requirement moved across the release line, so the history reads both ways
export function undeferRefusals(input: {
  status: RequirementStatus;
  reason: string | null | undefined;
}): RequirementRefusal[] {
  const out: RequirementRefusal[] = [];
  if (input.status !== 'deferred') {
    out.push({
      code: 'REQUIREMENT_NOT_DEFERRED',
      path: '',
      detail: `the requirement is ${input.status}, not deferred; only a deferred requirement is undeferred.`,
    });
  }
  if (!input.reason?.trim()) {
    out.push({
      code: 'REQUIREMENT_UNDEFER_REASON_REQUIRED',
      path: '/reason',
      detail:
        'an undeferred requirement says why it comes back into the current release, as its defer said why it left.',
    });
  }
  return out;
}
