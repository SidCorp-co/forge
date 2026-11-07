// The internal codes no room's reader is shown (ISS-872, ISS-873): an issue key, an MR or PR number,
// an environment variable's name, a commit sha or a credential word. One list, read by the support
// session's screen (`support/screen.ts`) and by a chat room agent's question posts
// (`assistant/chat-room/question-voice.ts`), each refusing by name with the one shape that passes.
//
// An issue key is read by its prefix, never by its shape alone (ISS-1107): a store's order number
// (RIV-68493) is a prefix, a dash and digits too. The prefixes are the ones core mints for its own
// records (`FORGE_KEY_PREFIXES`) and every Forge project's issue prefix, less the codes the project
// declared its users read as their own (`userFacingCodes` in its project document).

import { RECORD_KEY_PREFIXES } from '@forge/contracts/record-keys';
import type { MessageRefusal } from './contract.js';

/**
 * The prefixes core mints a record key under, whatever project: the records (`ISS-673`, `REQ-66`,
 * `FB-147`, `MK-10`, `record-keys.ts:RECORD_KEY_PREFIXES`), a requirement's criterion
 * (`requirements/rules.ts`, `BC-8`) and a lesson (`knowledge/lesson-entries.ts`, `L-65`).
 */
export const FORGE_KEY_PREFIXES: readonly string[] = [...RECORD_KEY_PREFIXES, 'BC', 'L'];

/**
 * The prefixes a room reads as issue keys: core's own and every project's `issuePrefixes`, less the
 * `userFacing` codes the project declared its own. Upper case, each once.
 */
export function keyPrefixesOf(
  issuePrefixes: readonly string[],
  userFacing: readonly string[],
): readonly string[] {
  const own = new Set(userFacing.map((p) => p.toUpperCase()));
  const all = [...FORGE_KEY_PREFIXES, ...issuePrefixes].map((p) => p.toUpperCase());
  return [...new Set(all)].filter((p) => /^[A-Z][A-Z0-9]*$/.test(p) && !own.has(p));
}

/** The kind an issue key is named by. */
export const ISSUE_KEY = 'issue key';

/** A key under one of `prefixes`: the prefix, a dash and a number (ISS-89, FB-12, REQ-77). */
function issueKeyRe(prefixes: readonly string[]): RegExp | null {
  if (prefixes.length === 0) return null;
  return new RegExp(`\\b(?:${prefixes.join('|')})-\\d{1,6}\\b`, 'g');
}

/** One kind of internal code besides an issue key, as the refusal names it, and how it is found. */
const INTERNAL_CODES: readonly { kind: string; re: RegExp }[] = [
  // GitLab's merge request reference (!5050), or a number said to be an MR or a PR
  { kind: 'MR or PR number', re: /(?<![\w!])!\d{1,7}\b/g },
  {
    kind: 'MR or PR number',
    re: /\b(?:PR|MR|pull\s+request|merge\s+request)\s*[#!]?\d{1,7}\b/gi,
  },
  // upper snake case with at least one underscore, a wildcard segment included (VIRTUAL_MACHINES_*_KEY)
  {
    kind: 'environment variable name',
    re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_(?:[A-Z0-9]+|\*))+(?![A-Za-z0-9_])/g,
  },
  // 7 to 40 lower-case hex holding a letter and a digit: an order number is digits alone
  {
    kind: 'commit sha',
    re: /(?<![A-Za-z0-9])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![A-Za-z0-9])/g,
  },
  {
    kind: 'credential word',
    re: /\b(?:tokens?|secrets?|passwords?|credentials?|key\s+rotation)\b/gi,
  },
];

/**
 * The internal codes a text holds, each with the words that hold it, in the order of the kinds; an
 * issue key is one under `keyPrefixes` (`keyPrefixesOf`).
 */
export function internalCodesIn(
  text: string,
  keyPrefixes: readonly string[],
): { kind: string; quote: string }[] {
  const found: { kind: string; quote: string }[] = [];
  const key = issueKeyRe(keyPrefixes);
  const kinds = key ? [{ kind: ISSUE_KEY, re: key }, ...INTERNAL_CODES] : INTERNAL_CODES;
  for (const { kind, re } of kinds) {
    for (const m of text.matchAll(re)) {
      if (!found.some((f) => f.quote === m[0])) found.push({ kind, quote: m[0] });
    }
  }
  return found;
}

/** The shape a post passes, said the same way by every refusal. */
export const PLAIN_WORDS_SHAPE =
  'Say it in plain words, with no issue key, MR or PR number, environment variable name, commit sha or credential word; an order number or a PO code such as PO001453760102901 may stay';

/** The door for a product's own code read as an issue key, said by every refusal of one. */
export const USER_FACING_CODES_DOOR =
  "A prefix your product's people read as their own code is declared in the project document's userFacingCodes";

/** The refusal a screen hands back for each code a text holds, with the shape that passes. */
export function internalCodeRefusals(
  text: string,
  where: string,
  keyPrefixes: readonly string[],
): MessageRefusal[] {
  return internalCodesIn(text, keyPrefixes).map((c) => ({
    rule: 'SUPPORT_INTERNAL_CODE',
    why: `${where}, and the message holds ${c.kind} "${c.quote}"`,
    quote: c.quote,
    shape:
      c.kind === ISSUE_KEY ? `${PLAIN_WORDS_SHAPE}. ${USER_FACING_CODES_DOOR}` : PLAIN_WORDS_SHAPE,
    example: 'Is the home page picture the one you approved last week?',
  }));
}
