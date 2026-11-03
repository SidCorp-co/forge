// What a release approval carries past the release approval checklist unproven, by name (ISS-914):
// `carry: [{ issue, n, why }]` or `carry: { all: true, why }` on an approve. The approver's word moves
// each named criterion from a gap to a `waived` answer holding the carried list; a criterion it does
// not name still refuses CHECKLIST_INCOMPLETE. A carry naming a criterion the release proves, or one
// it does not hold, is refused by its entry, and nothing is recorded. A carried criterion stays owed:
// nothing here or after marks it proven.

import type { Refusal } from '@forge/contracts/refusal';
import { RELEASE_CARRY_WHY_MAX, type ReleaseCarriedCriterion } from '@forge/contracts/releases';
import { refuseRelease } from './refuse.js';

export type Carry =
  | { all: true; why: string }
  | { issue: string; n: number; why: string; at: number }[];

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const SHAPE = 'a carry is [{ issue: "ISS-n", n, why }] or { all: true, why }';

function whyOf(raw: unknown, at: string): string {
  const why = typeof raw === 'string' ? raw.trim() : '';
  if (why.length < 1 || why.length > RELEASE_CARRY_WHY_MAX) {
    throw refuseRelease(
      'RELEASE_APPROVAL_SHAPE',
      `a carry says why it is carried, in 1 to ${RELEASE_CARRY_WHY_MAX} characters: the approver's own word, kept on the approval`,
      `${at}/why`,
    );
  }
  return why;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body's `carry`, refused by what is wrong with it and where. */
export function parseCarry(raw: unknown): Carry {
  if (isObject(raw)) {
    const extra = Object.keys(raw).filter((k) => k !== 'all' && k !== 'why');
    if (raw.all !== true || extra.length > 0) {
      throw refuseRelease(
        'RELEASE_APPROVAL_SHAPE',
        `${SHAPE}; the object form carries every unproven criterion and takes all: true and why only`,
        '/carry',
      );
    }
    return { all: true, why: whyOf(raw.why, '/carry') };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw refuseRelease('RELEASE_APPROVAL_SHAPE', `${SHAPE}, naming at least one`, '/carry');
  }
  const seen = new Set<string>();
  return raw.map((entry, at) => {
    const where = `/carry/${at}`;
    if (!isObject(entry) || Object.keys(entry).some((k) => !['issue', 'n', 'why'].includes(k))) {
      throw refuseRelease('RELEASE_APPROVAL_SHAPE', `${SHAPE}; entry ${at} is not`, where);
    }
    if (typeof entry.issue !== 'string' || !ISSUE_KEY.test(entry.issue)) {
      throw refuseRelease(
        'RELEASE_APPROVAL_SHAPE',
        'a carry names its issue by key, as ISS-12',
        `${where}/issue`,
      );
    }
    if (typeof entry.n !== 'number' || !Number.isInteger(entry.n) || entry.n < 1) {
      throw refuseRelease(
        'RELEASE_APPROVAL_SHAPE',
        'a carry names the criterion by its number on the issue, 1 or more',
        `${where}/n`,
      );
    }
    const key = `${entry.issue}#${entry.n}`;
    if (seen.has(key)) {
      throw refuseRelease(
        'RELEASE_APPROVAL_SHAPE',
        `${entry.issue} criterion ${entry.n} is carried twice; name each once`,
        where,
      );
    }
    seen.add(key);
    return { issue: entry.issue, n: entry.n, why: whyOf(entry.why, where), at };
  });
}

/**
 * The criteria `carry` names, resolved against what the release holds and what it leaves unproven
 * at the request's commit: each with its standing then and the approver's why. A carry naming a
 * criterion that is proven, or one the release does not hold, is a refusal on its entry.
 */
export function resolveCarry(
  carry: Carry,
  facts: {
    unproven: readonly { issue: string; n: number; standing: string }[];
    criteria: readonly { issue: string; n: number }[];
  },
): { carried: ReleaseCarriedCriterion[]; refusals: Refusal[] } {
  if (!Array.isArray(carry)) {
    return {
      carried: facts.unproven.map((u) => ({ ...u, why: carry.why })),
      refusals: [],
    };
  }
  const unproven = new Map(facts.unproven.map((u) => [`${u.issue}#${u.n}`, u]));
  const held = new Set(facts.criteria.map((c) => `${c.issue}#${c.n}`));
  const issues = new Set(facts.criteria.map((c) => c.issue));
  const carried: ReleaseCarriedCriterion[] = [];
  const refusals: Refusal[] = [];
  for (const entry of carry) {
    const key = `${entry.issue}#${entry.n}`;
    const owed = unproven.get(key);
    if (owed) {
      carried.push({ issue: owed.issue, n: owed.n, standing: owed.standing, why: entry.why });
    } else if (held.has(key)) {
      refusals.push({
        code: 'RELEASE_CARRY_PROVEN',
        path: `/carry/${entry.at}`,
        detail: `${entry.issue} criterion ${entry.n} is proven on the commit this approval ships, so there is nothing to carry: drop it from the carry`,
      });
    } else {
      refusals.push({
        code: 'RELEASE_CARRY_UNKNOWN',
        path: `/carry/${entry.at}`,
        detail: issues.has(entry.issue)
          ? `${entry.issue} has no criterion ${entry.n}; this release holds its criteria ${facts.criteria
              .filter((c) => c.issue === entry.issue)
              .map((c) => c.n)
              .join(', ')}`
          : `${entry.issue} is not on this release: a carry names an issue the release ships`,
      });
    }
  }
  return { carried, refusals };
}
