/**
 * The merge door's refusal of its own input, as the one sentence its caller reads in `message`:
 * what the mark needs, naming the field to fill in (ISS-1421 r9, criteria 63 and 131). zod's own
 * account stays in `details` for whoever reads the fields.
 */

import type { z } from 'zod';
import { type MarkDoor, markField } from './landing-evidence.js';

type MarkInputError = Pick<z.core.$ZodError, 'issues'>;

const MARK_KEYS = 'target, note, commit, landing and mergedAt';

const NEEDS: Readonly<Record<string, string>> = {
  id: 'Name the issue by its id, which is a UUID.',
  target: 'Name the branch the work merged into as `target`, in at most 200 characters.',
  note: 'Write `note` in at most 2000 characters, or leave it out.',
  commit: 'Name `commit` as a git sha of 7 to 64 hex characters, or leave it out.',
  landing: 'Name where the work landed as `landing`, in at most 2000 characters.',
  mergedAt:
    'Send `mergedAt` as an ISO date and time, such as 2026-10-18T09:00:00Z, or leave it out.',
};

/** A git mark sent with no target, or a blank one (criterion 131). */
export function targetRequiredDetail(door: MarkDoor): string {
  return door === 'mcp'
    ? `Name where the work merged as ${markField(door, 'target')}: base, prod or feature.`
    : `Name the branch the work merged into as ${markField(door, 'target')}.`;
}

export function markInputRefusal(error: MarkInputError): string {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    const [first] = issue.keys;
    const named = first && /^[A-Za-z_][\w]{0,39}$/.test(first) ? `\`${first}\`` : 'fields';
    const more = issue.keys.length > 1 ? ` and ${issue.keys.length - 1} more` : '';
    return `Leave out ${named}${more}, because a mark takes only ${MARK_KEYS}.`;
  }
  const field = issue?.path[0];
  return (
    (typeof field === 'string' ? NEEDS[field] : undefined) ??
    `Send the mark as an object naming only ${MARK_KEYS}.`
  );
}
