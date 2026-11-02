// The internal codes no room's reader is shown (ISS-872, ISS-873): an issue key, an MR or PR number,
// an environment variable's name, a commit sha or a credential word. One list, read by the support
// session's screen (`support/screen.ts`) and by a chat room agent's question posts
// (`assistant/chat-room/question-voice.ts`), each refusing by name with the one shape that passes.

import type { MessageRefusal } from './contract.js';

/** One kind of internal code, as the refusal names it, and how it is found. */
const INTERNAL_CODES: readonly { kind: string; re: RegExp }[] = [
  // a tracker's key: a project prefix, a dash and a number (ISS-89, FB-12, REQ-77)
  { kind: 'issue key', re: /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g },
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

/** The internal codes a text holds, each with the words that hold it, in the order of the kinds. */
export function internalCodesIn(text: string): { kind: string; quote: string }[] {
  const found: { kind: string; quote: string }[] = [];
  for (const { kind, re } of INTERNAL_CODES) {
    for (const m of text.matchAll(re)) {
      if (!found.some((f) => f.quote === m[0])) found.push({ kind, quote: m[0] });
    }
  }
  return found;
}

/** The shape a post passes, said the same way by every refusal. */
export const PLAIN_WORDS_SHAPE =
  'Say it in plain words, with no issue key, MR or PR number, environment variable name, commit sha or credential word; an order number or a PO code such as PO001453760102901 may stay';

/** The refusal a screen hands back for each code a text holds, with the shape that passes. */
export function internalCodeRefusals(text: string, where: string): MessageRefusal[] {
  return internalCodesIn(text).map((c) => ({
    rule: 'SUPPORT_INTERNAL_CODE',
    why: `${where}, and the message holds ${c.kind} "${c.quote}"`,
    quote: c.quote,
    shape: PLAIN_WORDS_SHAPE,
    example: 'Is the home page picture the one you approved last week?',
  }));
}
