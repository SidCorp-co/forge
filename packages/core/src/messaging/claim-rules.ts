/**
 * The rules that read the message against what the tracker holds.
 *
 * `issue-references-exist` is moved from the adapter tree unchanged.
 * `status-matches-the-row` is new, and is the gap ISS-997 exists to close: an
 * agent writing *merged, closed* to the person who decides met no check that
 * either had happened, while the same claim headed for a chat room was checked
 * thoroughly.
 */

import { formatIssueRef } from '../lib/issue-ref.js';
import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';
import { extractIssueClaims } from './issue-tokens.js';
import { extractStatusAssertions } from './status-assertions.js';

/** Every issue key a message names, read against the project's own rows. */
function missingKeys(text: string, f: MessageFacts): RuleBreak[] {
  return extractIssueClaims(text, f.prefixes)
    .issSeqs.filter((seq) => !f.knownIssueSeqs.has(seq))
    .map((seq) => {
      const ref = formatIssueRef(f.prefix, seq);
      return { quote: ref, why: `${ref} does not exist in this project` };
    });
}

/** Every issue key a message names is an issue this project holds. */
export const ISSUE_KEYS_EXIST: MessageRule = {
  id: 'issue-keys-exist',
  shape: 'name only issue keys this project holds',
  example: 'The change you asked about is done.',
  needs: ['prefixes', 'issue-rows'],
  check: (text, f) => (f.issueLookupFailed ? [] : missingKeys(text, f)),
};

/** Every issue this message names — key or link — has to be an issue this project holds. */
export const ISSUE_REFERENCES_EXIST: MessageRule = {
  id: 'issue-references-exist',
  shape: 'name only issues this project holds, exactly as a tool returned them',
  example: 'The change landed under the issue this comment is on.',
  needs: ['prefixes', 'issue-rows'],
  check: (text, f) => {
    if (f.issueLookupFailed) return [];
    const claims = extractIssueClaims(text, f.prefixes);
    const breaks: RuleBreak[] = [];
    for (const id of claims.malformedUrlIds) {
      breaks.push({ quote: id, why: `issue link id "${id}" is not a real issue id` });
    }
    for (const id of claims.urlIds) {
      if (!f.knownIssueIds.has(id)) {
        breaks.push({ quote: id, why: `issue link id "${id}" does not exist in this project` });
      }
    }
    breaks.push(...missingKeys(text, f));
    return breaks;
  },
};

const HELD = {
  merged: 'a merge',
  closed: 'a closure',
} as const;

/**
 * A status asserted of a named issue, checked against that issue's own row.
 */
export const STATUS_MATCHES_THE_ROW: MessageRule = {
  id: 'status-matches-the-row',
  shape:
    'record it on the tracker first and then say so, or say what you did without claiming the tracker’s word for it',
  example: 'The branch is pushed and the PR is open; nothing is merged yet.',
  needs: ['prefixes', 'issue-rows'],
  check: (text, f) => {
    if (f.issueLookupFailed) return [];
    const breaks: RuleBreak[] = [];
    for (const a of extractStatusAssertions(text, f.prefixes)) {
      const row = f.issueRows.get(a.seq);
      if (!row) continue;
      const holds = a.claim === 'merged' ? row.merged : row.status === 'closed';
      if (holds) continue;
      const ref = formatIssueRef(f.prefix, a.seq);
      breaks.push({
        quote: a.quote,
        why: `the message says ${ref} is ${a.claim}, and the tracker holds no ${HELD[a.claim]} for it — ${ref} is ${row.status}${row.merged ? ' and merged' : ' and unmerged'}`,
      });
    }
    return breaks;
  },
};
