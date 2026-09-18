/**
 * The rules that read the message and nothing else. Moved here out of the
 * adapter tree they grew up in, whose behaviour they keep exactly —
 * `legacy-verdicts.fixture.json` is the generated baseline that says so.
 */

// cm:ignore CM013 — every frozen comment in this file is an `i18n-allow` pragma carrying the Vietnamese phrasing its regex matches; deleting one to pay the drain reds the language gate instead, so this file's debt cannot be paid the ordinary way.

import { scrubLogText } from '@forge/observability';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';
import { issueTokenRe } from './issue-tokens.js';
import { OPTION_LINE_RE } from './option-line.js';
import { extractStatusAssertions } from './status-assertions.js';

const one = (why: string, quote: string | null = null): RuleBreak[] => [{ why, quote }];
const none: RuleBreak[] = [];

/**
 * A segment with nothing in it. Halts the rest of the rules for that segment:
 * every other rule below would have nothing to say about it anyway.
 */
export const NON_EMPTY: MessageRule = {
  id: 'non-empty',
  halts: true,
  shape: 'every part of the message carries text',
  example: 'Which environment should this deploy to?',
  needs: [],
  check: (text) => (text.trim() ? none : one('a question carries no empty prompt or option label')),
};

export const COMMENT_HAS_TEXT: MessageRule = {
  id: 'comment-has-text',
  halts: true,
  shape: 'the comment carries text',
  example: 'Merged and deployed; the walk is on the issue.',
  needs: [],
  check: (text) => (text.trim() ? none : one('a comment with no text carries nothing to say')),
};

/**
 * A record's `lead` with nothing in it. Halts, for `COMMENT_HAS_TEXT`'s reason.
 */
// cm:guard a third row of the same shape rather than `NON_EMPTY` reused, and for the reason that
// already made `COMMENT_HAS_TEXT` a row of its own: the sentence a writer is shown has to name the
// thing it broke. `NON_EMPTY` says "a question carries no empty prompt or option label" and offers
// a question as its example, which tells somebody who wrote a blank lead nothing about a lead
// (ISS-1089).
export const LEAD_HAS_TEXT: MessageRule = {
  id: 'lead-has-text',
  halts: true,
  shape: 'the lead is one sentence saying what was found',
  example: 'The comment screen admits a 1,662-character wall on one line.',
  needs: [],
  check: (text) =>
    text.trim()
      ? none
      : one('the record carries a lead with no text, so it says nothing was found'),
};

const SHOUT_RE = /(^|\s)@(all|here|channel)\b/i;

/**
 * A channel-wide mention written by an agent pages everyone in a room the
 * project bound for its own work. The notification is not the agent's to send.
 */
// cm:guard two rows, one body, and the two `why` texts are NOT interchangeable: one is a question put to the people who can answer it, the other is a comment being carried into a room that did not write it. The consequence differs, so the sentence a writer is shown differs.
function broadcastRule(id: string, why: (shout: string) => string): MessageRule {
  return {
    id,
    shape: 'no `@all`, `@here` or `@channel` — name the people who can act on it',
    example: 'Which environment should this deploy to?',
    needs: [],
    check: (text) => {
      const shout = text.match(SHOUT_RE);
      return shout ? one(why(shout[0].trim()), shout[0].trim()) : none;
    },
  };
}

export const NO_ROOM_BROADCAST_ASK = broadcastRule(
  'no-room-broadcast',
  (s) =>
    `text addresses the whole room ("${s}") — a question is put to the people who can answer it, not broadcast`,
);

export const NO_ROOM_BROADCAST_CARRIED = broadcastRule(
  'no-room-broadcast',
  (s) =>
    `the comment addresses the whole room ("${s}") — carrying it would page everyone in a room that did not write it`,
);

/**
 * A newline inside a segment lets one option label render as two lines, and a
 * line that looks like another option's is a choice the person never saw
 * offered — the reply token resolves by line, so this is impersonation.
 */
export const SINGLE_LINE: MessageRule = {
  id: 'single-line',
  shape: 'each part of the question is one line',
  example: 'Which environment should this deploy to?',
  needs: [],
  check: (text) =>
    /[\r\n]/.test(text)
      ? one('text spans more than one line, which lets it render as a second option')
      : none,
};

/** A label that renders as its own option line offers a choice nobody wrote. */
export const NO_OPTION_LINE: MessageRule = {
  id: 'no-option-line',
  shape: 'no part opens with something that reads as an option number',
  example: 'the staging environment',
  needs: [],
  check: (text) =>
    OPTION_LINE_RE.test(text)
      ? one(
          'text opens with something that reads as an option number, which collides with the list it sits in',
        )
      : none,
};

/**
 * The scrubber is the DETECTOR here, not the fixer: redacting on the way out
 * would post `[redacted]` and leave the question unanswerable rather than
 * refused. Compare, and refuse.
 */
export const NO_REDACTED_SECRET: MessageRule = {
  id: 'no-redacted-secret',
  shape: 'no token, key or connection string — name the credential entry instead',
  example: 'the deploy credential this project holds',
  needs: [],
  check: (text) =>
    scrubLogText(text) !== text ? one('text carries something the secret scrubber redacts') : none,
};

const CODE_FENCE_RE = /```/;
const PATH_LINE_RE = /(?:^|\s)[\w./-]*[\w-]\.[a-z]{1,5}:\d+\b/i;

// cm:guard keep this to unambiguous Forge jargon — common dictionary words (open/testing/closed/approved/waiting/draft/released) are excluded deliberately, because matching them retry-loops on legitimate prose
const STATUS_ENUM_RE = /\b(needs_info|in_progress|on_hold|clarified|reopen|developed)\b/i;

const REPHRASE =
  'rephrase for a non-technical stakeholder: no code, file paths, status codes, or issue ids';

/** Developer detail put to somebody who holds no role and cannot act on it. */
export const NO_DEVELOPER_DETAIL: MessageRule = {
  id: 'no-developer-detail',
  shape: 'plain language — no code blocks, file paths or raw pipeline statuses',
  example: 'The fix is in and the change is live.',
  needs: [],
  check: (text) => {
    const breaks: RuleBreak[] = [];
    if (CODE_FENCE_RE.test(text)) {
      breaks.push({ quote: '```', why: `reply contains a code block — ${REPHRASE}` });
    }
    const path = text.match(PATH_LINE_RE);
    if (path) {
      breaks.push({
        quote: path[0].trim(),
        why: `reply exposes developer detail (\`${path[0].trim()}\`) — ${REPHRASE}`,
      });
    }
    const status = text.match(STATUS_ENUM_RE);
    if (status) {
      breaks.push({
        quote: status[0],
        why: `reply leaks a raw pipeline status ("${status[0]}") — rephrase for a non-technical stakeholder: describe progress in plain language instead`,
      });
    }
    return breaks;
  },
};

/**
 * The names of the tools whose results are the TRACKER speaking.
 */
// cm:guard an allowlist and not "every tool that did not error": a room-history or a memory-search
// result is user-authored text, so an issue key somebody once typed into a chat message would
// verify itself — which is the fabrication this rule exists to catch, arriving by a longer road
// (ISS-1057, codex F2). `forge` is the tracker's own CLI; a tracker tool added later joins it here.
const TRACKER_TOOLS = new Set(['forge', 'forge_issues']);

/**
 * Every issue reference this turn's own tracker calls RETURNED.
 */
// cm:guard an id present in the call's own ARGUMENTS is not returned by it, however it came back:
// a model that invents `ISS-9999`, asks for it and reads it out of the refusal would otherwise
// have verified its own invention. Measured over beta's QA window at 45d92580 this keeps exactly
// that case refused — a fabricated `ISS-1028` the model asked for, was refused, then echoed into a
// search — while admitting the 21 real ids the screen was refusing (ISS-1057, codex F1).
function refsTheTrackerReturned(facts: MessageFacts): Set<string> {
  const returned = new Set<string>();
  for (const call of facts.toolCalls) {
    if (call.isError === true) continue;
    if (!TRACKER_TOOLS.has(call.name)) continue;
    const args = call.arguments ?? '';
    for (const ref of call.resultIssueRefs ?? []) {
      if (!args.toUpperCase().includes(ref)) returned.add(ref);
    }
  }
  return returned;
}

/**
 * An issue cited to a reader that this turn did not actually verify.
 */
// cm:guard "verified" means EITHER the project holds it OR this turn's tracker call returned it,
// and the second arm is what the rule's own `shape` has always claimed to screen for. Without it
// the rule asked a different question — does this project hold the row — and refused a reply
// quoting an issue's own title back, because a title may name another project's key: measured over
// beta's QA window at 45d92580, `ISS-538` in the title `ISS-538 TC2 exe reject` was refused 28
// times, and the corrective message the refusal sends says *cite issue ids only exactly as tools
// returned them*, which is precisely what the reply had done. The single-issue task was 0/6 with a
// correct first attempt every time (ISS-1057).
export const ONLY_VERIFIED_CITATIONS: MessageRule = {
  id: 'only-verified-citations',
  shape: 'cite no issue id to a stakeholder unless this turn looked it up',
  example: 'The change you asked about is done.',
  needs: ['prefixes', 'issue-rows'],
  check: (text, f) => {
    if (f.issueLookupFailed) return none;
    const returned = refsTheTrackerReturned(f);
    // cm:guard an id known ONLY from a result's prose may be MENTIONED and never ASSERTED ABOUT,
    // and the two are separated here because only the second is a claim: a tracker result carries
    // user-authored titles and descriptions, so the id in `ISS-538 TC2 exe reject` is a row this
    // project does not hold appearing inside a row it does — quoting that title back is the answer,
    // and `ISS-9999 is shipped` sourced from the same prose is a state claim nothing checked.
    // `status-matches-the-row` cannot catch it: that rule abstains on a row this project has no
    // entry for, which is correct for another project's key and is exactly the gap (codex F3 of the
    // whole-set read, still open at its first recheck).
    const asserted = new Set(extractStatusAssertions(text, f.prefixes).map((a) => a.seq));
    const breaks: RuleBreak[] = [];
    for (const m of text.matchAll(issueTokenRe(f.prefixes))) {
      const seq = Number(m[2]);
      if (f.knownIssueSeqs.has(seq)) continue;
      if (returned.has((m[0] as string).toUpperCase()) && !asserted.has(seq)) continue;
      const ref = formatIssueRef(f.prefix, seq);
      breaks.push({
        quote: m[0],
        why: asserted.has(seq)
          ? `reply states what "${ref}" is, and this turn only saw that id inside another issue's text — say what you read it in, or look it up, rather than reporting its status — ${REPHRASE}`
          : `reply cites "${ref}" which was not verified this turn — ${REPHRASE}`,
      });
    }
    return breaks;
  },
};

// cm:guard no \b wrapping: JS's non-unicode \b treats accented Vietnamese letters as non-word characters, so a boundary before a phrase-initial word never matches — the internal `\s+` already delimits each alternative // i18n-allow: refers to the Vietnamese phrase words above
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** A Forge issue-navigation target: `/projects/<slug>/issues/<segment>`, behind a host and/or a `#` or not. */
// cm:why a backtick, a pipe and an asterisk end the segment too: a technical reply puts a valid path in inline code and the closing backtick is not part of the documentId (codex F3).
// cm:guard a navigation path starts where a path starts — at the text's edge, after whitespace or an opening quote/bracket/backtick, or after an origin — never inside a longer path: `/api/projects/<uuid>/issues/search` is the API, not a link (codex F1 at effaee99).
export const ISSUE_NAV_RE =
  /(?<![^\s([<"'`*_])(?:https?:\/\/[^\s/]+\/?)?(#?)\/projects\/([\w-]+)\/issues\/([^\s/?#)\]>,.;:!"'`|*]+)/gi;

/** An issue link the web can open, or none. */
// cm:guard scoped to Forge NAVIGATION targets and nothing else that has `/issues/` in it: `/api/issues/<id>/comments`, `packages/core/src/issues/routes.ts` and another host's tracker are legitimate in a role-holder's answer, and a rule refusing every `/issues/` path would refuse them in the one cell built to allow technical detail (ISS-1041, codex F5). What it refuses is the shape the persona prescribes and the model drifted from on beta: a hash route, or a segment that is not the documentId.
export const ISSUE_LINK_SHAPE: MessageRule = {
  id: 'issue-link-shape',
  shape:
    'an issue link reads <base>/projects/<slug>/issues/<documentId> — the documentId a UUID, never a hash route and never an issue key or number in the path',
  // cm:why the example carries no link at all: in `public:report` the sibling `issue-references-exist` refuses any documentId the example facts do not know, and an example must pass every rule of its cell.
  example: 'The CSV export fix is in; the tracker has the issue with its link.',
  needs: [],
  check: (text) => {
    const breaks: RuleBreak[] = [];
    for (const m of text.matchAll(ISSUE_NAV_RE)) {
      const [whole, hash, slug, segment] = m as unknown as [string, string, string, string];
      const want = `/projects/${slug}/issues/<documentId>`;
      if (hash) {
        breaks.push({
          quote: whole,
          why: `the link is a hash route the web does not serve — write ${want} (\`forge issue ISS-n\` prints the documentId)`,
        });
      } else if (!UUID_RE.test(segment)) {
        breaks.push({
          quote: whole,
          why: `the link ends in "${segment}", which is not the issue's documentId — write ${want} (\`forge issue ISS-n\` prints it)`,
        });
      }
    }
    return breaks;
  },
};

const EMPTY_PROMISE_RE =
  /sẽ\s+(kiểm tra|phản hồi|báo(\s+lại)?|cập nhật|xem)|đang\s+(kiểm tra|xử lý)|để\s+(mình|tôi)\s+(kiểm tra|xem)|chờ\s+(mình|tôi)|\bI('?ll| will)\s+(check|look into|get back|investigate)\b|\bget back to you\b/i; // i18n-allow: matches the Vietnamese/English "future promise, no result" phrasing being policed

/**
 * A promise of a later turn, where the agent has no later turn. The reader owes
 * nothing on a report, so a promise to come back is a message that says nothing.
 */
// cm:guard this rule is for `report` only and must never reach an `ask` cell: naming what you still need IS the point of an ask, and reading that as an empty promise refuses the one message the reader is there to answer.
export const NO_EMPTY_PROMISE: MessageRule = {
  id: 'no-empty-promise',
  shape: 'report the result you have, or say exactly what is missing',
  example: 'The deploy is done; the one check still red is the integration suite.',
  needs: [],
  check: (text) =>
    EMPTY_PROMISE_RE.test(text)
      ? one(
          'reply promises a future action but there is no follow-up turn — do the work now and report the result, or state exactly what is missing',
        )
      : none,
};
