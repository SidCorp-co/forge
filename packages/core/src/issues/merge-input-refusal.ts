/**
 * The merge door's refusal of its own input, as the one sentence its caller reads in `message`:
 * what the mark needs, naming the field to fill in, as each door's caller sends it (ISS-1421 r9 and
 * r10, criteria 63, 119 and 131). zod's own account stays in `details` for whoever reads the fields.
 */

import type { z } from 'zod';
import { type MarkDoor, markField } from './landing-evidence.js';

type MarkInputError = Pick<z.core.$ZodError, 'issues'>;

const MARK_KEYS: Readonly<Record<MarkDoor, string>> = {
  rest: 'target, note, commit, landing and mergedAt',
  mcp: 'issueId, target, note, commit, landing and mergedAt',
};

/** `note` is the one field whose bound differs: MCP's `data.note` is shared with its other actions. */
const NOTE_MAX: Readonly<Record<MarkDoor, number>> = { rest: 2000, mcp: 10_000 };

const field = (door: MarkDoor, name: string) => `\`${door === 'mcp' ? `data.${name}` : name}\``;

function needs(door: MarkDoor, name: string): string | undefined {
  switch (name) {
    case 'id':
      return 'Name the issue by its id, which is a UUID.';
    case 'issueId':
      return `Name the issue as ${field(door, 'issueId')}.`;
    case 'target':
      return door === 'mcp'
        ? targetRequiredDetail(door)
        : `Name the branch the work merged into as ${field(door, 'target')}, in at most 200 characters.`;
    case 'note':
      return `Write ${field(door, 'note')} in at most ${NOTE_MAX[door]} characters, or leave it out.`;
    case 'commit':
      return `Name ${field(door, 'commit')} as a git sha of 7 to 64 hex characters, or leave it out.`;
    case 'landing':
      return `Name where the work landed as ${field(door, 'landing')}, in at most 2000 characters.`;
    case 'mergedAt':
      return `Send ${field(door, 'mergedAt')} as an ISO date and time, such as 2026-10-18T09:00:00Z, or leave it out.`;
    default:
      return undefined;
  }
}

/** A git mark sent with no target, a blank one, or (on MCP) one that is none of its three words. */
export function targetRequiredDetail(door: MarkDoor): string {
  return door === 'mcp'
    ? `Name where the work merged as ${markField(door, 'target')}: base, prod or feature.`
    : `Name the branch the work merged into as ${markField(door, 'target')}.`;
}

/** A `mergedAt` that names no date and time, at either door. */
export function mergedAtRefusal(door: MarkDoor): string {
  return needs(door, 'mergedAt') as string;
}

/** The field a refused issue names: REST's body is the mark, MCP's mark sits under `data`. */
function fieldOf(path: readonly PropertyKey[], door: MarkDoor): PropertyKey | undefined {
  return door === 'mcp' ? (path[0] === 'data' ? path[1] : undefined) : path[0];
}

export function markInputRefusal(error: MarkInputError, door: MarkDoor = 'rest'): string {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    const [first] = issue.keys;
    const underData = door === 'rest' || issue.path[0] === 'data';
    const named =
      first && /^[A-Za-z_][\w]{0,39}$/.test(first)
        ? underData
          ? field(door, first)
          : `\`${first}\``
        : 'fields';
    const more = issue.keys.length > 1 ? ` and ${issue.keys.length - 1} more` : '';
    return `Leave out ${named}${more}, because a mark takes only ${MARK_KEYS[door]}.`;
  }
  const name = issue ? fieldOf(issue.path, door) : undefined;
  const where = door === 'mcp' ? ' under `data`' : '';
  return (
    (typeof name === 'string' ? needs(door, name) : undefined) ??
    `Send the mark as an object${where} naming only ${MARK_KEYS[door]}.`
  );
}

/** MCP's `mark_merged` and `unmark` refused by the tool's input schema, in the mark's own sentence
 *  rather than zod's (ISS-1421 r10: a blank `data.target` read "Invalid option: expected one of"). */
export function refusedAsMark<T>(args: unknown, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    const action = (args as { action?: unknown } | null)?.action;
    const issues = (err as { name?: unknown; issues?: unknown } | null)?.issues;
    const zod = (err as { name?: unknown } | null)?.name === 'ZodError' && Array.isArray(issues);
    // Only the mark's own fields, under `data`: a top-level field keeps the tool's own refusal.
    const underData = zod && (issues as Array<{ path?: unknown[] }>)[0]?.path?.[0] === 'data';
    if (underData && (action === 'mark_merged' || action === 'unmark')) {
      throw new Error(`BAD_REQUEST: ${markInputRefusal(err as MarkInputError, 'mcp')}`);
    }
    throw err;
  }
}
