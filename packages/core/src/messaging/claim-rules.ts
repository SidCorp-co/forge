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
import { extractIssueClaims, turnCreatedIssue } from './issue-tokens.js';
import { extractStatusAssertions } from './status-assertions.js';

/** Every issue this message names has to be an issue this project holds. */
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
    for (const seq of claims.issSeqs) {
      if (!f.knownIssueSeqs.has(seq)) {
        breaks.push({
          quote: formatIssueRef(f.prefix, seq),
          why: `${formatIssueRef(f.prefix, seq)} does not exist in this project`,
        });
      }
    }
    if (
      claims.claimsCreation &&
      !turnCreatedIssue(f.toolCalls) &&
      claims.urlIds.length === 0 &&
      claims.issSeqs.length === 0
    ) {
      breaks.push({
        quote: null,
        why: 'reply claims an issue was created but no forge_issues create call was made',
      });
    }
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
// cm:guard the `shape` names the RECORD-FIRST remedy ahead of the reword, because the common case is an agent that genuinely did the thing and is reporting it a moment before it stamps the mark. Telling that agent only to reword would have it write a weaker sentence about work that really did merge, instead of putting the tracker right — and a contract that makes the record worse to satisfy itself is the failure this issue names.
// cm:guard the grammar behind this ABSTAINS by default and that is the point, not a shortfall: it is high precision and low recall by choice, because a false refusal is a tax on every agent in the fleet while a missed claim is the state the tracker was already in. Widening it to catch more claims is how this rule becomes the thing it was built to prevent.
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
