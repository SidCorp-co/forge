/**
 * The rule that holds a reply's claim to have made a record against what the turn actually did.
 *
 * Chat records Feedback (`forge_feedback`) or a Requirement draft or revision
 * (`forge_requirement_draft`, `forge_requirement_revise`) after the person confirms, and never an
 * issue (owner ruling 2026-10-08: the kernel refuses a chat credential `CHAT_FILES_FEEDBACK_NOT_ISSUES`).
 * So "I recorded this as FB-112" is true only where this turn wrote a Feedback, and "I created an
 * issue" is false whatever the turn did. An Agent session has no record tools; its write is a REST
 * POST to the project's `feedback` or `requirements` route, read from its Bash call.
 */

// every Vietnamese literal here is an `i18n-allow` pragma carrying the phrasing the detector must read; people chat in Vietnamese.

import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';
import { claimsIssueCreated } from './issue-tokens.js';
import { blankMarkedClauses } from './reply-marks.js';

type Call = MessageFacts['toolCalls'][number];
type RecordKind = 'feedback' | 'requirement';

const KEY_RE = /\b(FB|REQ)-(\d{1,6})\b/giu;

const VERB_EN = /\b(?:recorded|logged|filed|drafted|proposed|saved|captured|submitted|created)\b/iu;
// i18n-allow: the Vietnamese past-tense recording verbs the detector reads
const VERB_VI = /(?:đã|vừa)\s+(?:ghi\s+nhận|ghi|lưu|tạo|soạn|đề\s+xuất|gửi|thêm)\b/iu; // i18n-allow: matches the Vietnamese phrasing of the claim being policed
const KEYLESS_NOUN = /\b(feedback|requirement|revision)\b/iu;

const writes = (calls: readonly Call[]) => calls.filter((c) => !c.isError);

/** A REST POST an Agent session made to a project's feedback or requirement route. */
function restPost(c: Call, route: 'feedback' | 'requirements'): boolean {
  if (c.name !== 'Bash') return false;
  const cmd = c.arguments;
  return (
    new RegExp(`projects/[^\\s"'\\\\]+/${route}\\b`).test(cmd) &&
    /(?:-X\s*POST|--request\s+POST|\s-d\s|--data)/.test(cmd)
  );
}

const named = (c: Call, tool: string) => c.name === tool || c.name.endsWith(`__${tool}`);

function feedbackWritten(calls: readonly Call[]): boolean {
  return writes(calls).some((c) => {
    if (named(c, 'forge_feedback') || restPost(c, 'feedback')) return true;
    if (c.name !== 'forge') return false;
    try {
      const argv = (JSON.parse(c.arguments) as { argv?: unknown }).argv;
      return Array.isArray(argv) && argv[0] === 'feedback';
    } catch {
      return false;
    }
  });
}

/** Whether the turn wrote the requirement `ref` names: any draft, a revision of that REQ, or a REST POST. */
function requirementWritten(calls: readonly Call[], ref: string | null): boolean {
  return writes(calls).some((c) => {
    if (named(c, 'forge_requirement_draft') || restPost(c, 'requirements')) return true;
    if (!named(c, 'forge_requirement_revise')) return false;
    if (ref === null) return true;
    try {
      const target = (JSON.parse(c.arguments) as { requirement?: unknown }).requirement;
      return typeof target !== 'string' || target.toUpperCase() === ref;
    } catch {
      return true;
    }
  });
}

const sentences = (text: string): { body: string; question: boolean }[] =>
  [...text.matchAll(/([^.!?\n]+)([.!?\n]|$)/gu)].map((m) => ({
    body: (m[1] ?? '').trim(),
    question: m[2] === '?',
  }));

/** Every record the reply says it made that this turn did not make, quoted. */
function ungroundedRecords(text: string, calls: readonly Call[]): RuleBreak[] {
  const breaks: RuleBreak[] = [];
  for (const { body, question } of sentences(blankMarkedClauses(text))) {
    if (question || !body || !(VERB_EN.test(body) || VERB_VI.test(body))) continue;
    const keys = [...body.matchAll(KEY_RE)].map((m) => `${(m[1] ?? '').toUpperCase()}-${m[2]}`);
    const claimed: { kind: RecordKind; ref: string | null }[] = keys.map((k) => ({
      kind: k.startsWith('FB-') ? 'feedback' : 'requirement',
      ref: k,
    }));
    if (keys.length === 0 && VERB_EN.test(body)) {
      const noun = KEYLESS_NOUN.exec(body)?.[1]?.toLowerCase();
      if (noun) claimed.push({ kind: noun === 'feedback' ? 'feedback' : 'requirement', ref: null });
    }
    for (const c of claimed) {
      const held =
        c.kind === 'feedback' ? feedbackWritten(calls) : requirementWritten(calls, c.ref);
      if (held) continue;
      const what = c.kind === 'feedback' ? 'Feedback' : 'a Requirement draft or revision';
      breaks.push({
        quote: body,
        why: `reply claims ${what} was recorded${c.ref ? ` (${c.ref})` : ''} but this turn made no ${c.kind === 'feedback' ? '`forge_feedback` call or POST to the feedback route' : '`forge_requirement_draft` or `forge_requirement_revise` call or POST to the requirements route'}`,
      });
    }
  }
  return breaks;
}

/** A claim to have created a record, held to what the turn wrote; a claim to have created an issue is always false from chat. */
export const CREATION_CLAIMS_GROUNDED: MessageRule = {
  id: 'creation-claims-grounded',
  shape:
    'say a record was made only where this turn made it: Feedback or a Requirement draft, never an issue',
  example: 'I have not recorded anything yet; tell me to and I will record it as Feedback.',
  needs: ['prefixes'],
  check: (text, f) => {
    const breaks = ungroundedRecords(text, f.toolCalls);
    const unmarked = blankMarkedClauses(text);
    if (claimsIssueCreated(unmarked, f.prefixes)) {
      breaks.push({
        quote: null,
        why: 'reply claims an issue was created, and chat cannot create one (CHAT_FILES_FEEDBACK_NOT_ISSUES): it records Feedback or a Requirement draft',
      });
    }
    return breaks;
  },
};
