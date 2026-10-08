/**
 * The rule that holds a reply's claim to have made a record against what the turn actually did.
 *
 * Chat records Feedback (`forge_feedback`) or a Requirement draft or revision
 * (`forge_requirement_draft`, `forge_requirement_revise`; at a requirement's BA door `ba_suggest` and
 * `ba_suggest_requirement`) after the person confirms, and never an
 * issue (owner ruling 2026-10-08: the kernel refuses a chat credential `CHAT_FILES_FEEDBACK_NOT_ISSUES`).
 * So "I recorded this as FB-112" is true only where this turn wrote a Feedback, and "I created an
 * issue" is false whatever the turn did. An Agent session has no record tools; its write is a REST
 * POST to the project's `feedback` or `requirements` route, read from its Bash call.
 *
 * The same holds a claim to have shared an answer or saved a report (REQ-32): "I shared this", a
 * share link in the reply, or "I saved the report" is true only where this turn created a share
 * (`POST /api/projects/:id/shares`) or saved a report: `forge_template_save` from the Assistant, or
 * `POST /api/projects/:id/status/reports` from an Agent session, the one service behind both. The
 * Assistant has no share tool, so from it a share claim is always held.
 *
 * A save or share claim is read as an act, not as a list of sentences: a save verb in a completed or
 * passive form ("saved", "stored", "is saved", "has been saved", a sentence opening "Saved the…",
 * and the Vietnamese forms `SAVE_ACT_VI` reads) in a sentence naming what a save keeps (a report, an
 * answer, its results, the report history). QA of ISS-422 on dev.185: "its results are saved in the
 * project report history" and "Saved the progress report to the project report history" both went
 * out with no save behind them, because the rule knew only "I saved … report" and "report is saved".
 * A negation, a modal or future ("will be saved", "can save") and a conditional ("once it is saved")
 * do not claim the act, and neither does a question.
 *
 * A hedge exempts none of these. Marking a clause unverified (`reply-marks.ts`) lets a claim about
 * the world that the turn could not check go out; a claim to have written a record is about the
 * turn itself, and is true or false whatever it is marked (QA of ISS-407 on dev: "I recorded this
 * as FB-9999 (unverified, this may be wrong)" passed with no write behind it).
 */

// every Vietnamese literal here is an `i18n-allow` pragma carrying the phrasing the detector must read; people chat in Vietnamese.

import { SHARE_TOKEN_PREFIX } from '@forge/contracts/shares';
import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';
import { claimsIssueCreated } from './issue-tokens.js';

type Call = MessageFacts['toolCalls'][number];
type RecordKind = 'feedback' | 'requirement';

const KEY_RE = /\b(FB|REQ)-(\d{1,6})\b/giu;

const VERB_EN = /\b(?:recorded|logged|filed|drafted|proposed|saved|captured|submitted|created)\b/iu;
// i18n-allow: the Vietnamese past-tense recording verbs the detector reads
const VERB_VI = /(?:đã|vừa)\s+(?:ghi\s+nhận|ghi|lưu|tạo|soạn|đề\s+xuất|gửi|thêm)\b/iu; // i18n-allow: matches the Vietnamese phrasing of the claim being policed
const KEYLESS_NOUN = /\b(feedback|requirement|revision)\b/iu;

const SHARE_EN =
  /\b(?:I(?:'ve| have| just)?|we(?:'ve| have| just)?)\s+(?:just\s+)?(?:shared|created (?:a|the|your) (?:share |sharing )?link|made (?:a|the|your) (?:share |sharing )?link)\b|\b(?:share|sharing) link (?:is ready|has been created|was created)\b|\b(?:has|have) been shared\b|\b(?:is|are|was|were)\s+(?:now\s+)?shared\b|^\W*shared\s+(?:the|this|your|it)\b|\bhere(?:'s| is) (?:the|your) (?:share|sharing) link\b/iu;
const SHARE_VI =
  /(?:đã|vừa)\s+(?:chia\s+sẻ|tạo\s+(?:đường\s+)?(?:link|liên\s+kết))|đã\s+được\s+chia\s+sẻ|(?:link|liên\s+kết)\s+chia\s+sẻ\s+(?:đây|của\s+bạn)/iu; // i18n-allow: the Vietnamese phrasing of a share claim being policed

/** A save verb in a completed or passive form: the act claimed, wherever its subject stands. */
const SAVE_ACT_EN =
  /\b(?:I|we)(?:'ve|’ve| have| had| just)?\s+(?:just\s+|now\s+|also\s+|already\s+)?(?:saved|stored|archived)\b|^\W*(?:saved|stored|archived)\s+(?:the|this|your|it|a|an|its)\b|\b(?:is|are|was|were|has\s+been|have\s+been|'s\s+been|got|gets)\s+(?:now\s+|also\s+|already\s+|successfully\s+|safely\s+)?(?:saved|stored|archived)\b|\b(?:is|are)\s+(?:now\s+)?(?:in|listed\s+in|available\s+in)\s+(?:the|your)\s+(?:project(?:'s|’s)?\s+)?report\s+history\b|\badded\s+(?:it\s+|them\s+)?to\s+(?:the|your)\s+(?:project(?:'s|’s)?\s+)?(?:report\s+)?history\b/iu;
const SAVE_ACT_VI =
  /(?:đã|vừa)\s+(?:được\s+)?lưu|được\s+lưu\s+(?:lại\s+)?(?:vào|trong|ở|tại)|(?:đã|vừa)\s+(?:thêm|đưa)\s+(?:\S+\s+){0,4}vào\s+lịch\s+sử|(?:đã|hiện)\s+(?:nằm|có\s+mặt)\s+trong\s+lịch\s+sử/iu; // i18n-allow: the Vietnamese phrasing of a report-save act being policed
/** What a save keeps: the claim is about a report only where the sentence names one. */
const SAVE_OBJECT =
  /\b(?:reports?|answers?|results?|summary|history)\b|báo\s+cáo|kết\s+quả|câu\s+trả\s+lời|lịch\s+sử|bản\s+tóm\s+tắt/iu; // i18n-allow: the Vietnamese nouns a save keeps
/** Words before the act that make it not happen, not yet, or only if: then nothing is claimed. */
const NOT_CLAIMED =
  /\b(?:if|once|when|whenever|after|until|unless|whether|before)\b|\b(?:nếu|khi|sau\s+khi|trước\s+khi|để)\s|(?:chưa|không|sẽ|có\s+thể)\s+(?:\S+\s+){0,1}$/iu; // i18n-allow: the Vietnamese conditional and negating words

/** Whether the sentence claims a report was saved: the act, its object, and nothing before it that undoes it. */
function claimsSave(body: string): boolean {
  if (!SAVE_OBJECT.test(body)) return false;
  for (const re of [SAVE_ACT_EN, SAVE_ACT_VI]) {
    const m = re.exec(body);
    if (m && !NOT_CLAIMED.test(body.slice(0, m.index))) return true;
  }
  return false;
}

const SHARE_TOKEN_RE = new RegExp(`${SHARE_TOKEN_PREFIX}[A-Za-z0-9_-]{8,}`);

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

/** A REST POST an Agent session made to exactly this project route, not to one beneath it. */
function restPostExact(c: Call, route: string): boolean {
  if (c.name !== 'Bash') return false;
  const cmd = c.arguments;
  return (
    new RegExp(`projects/[^\\s"'\\\\]+/${route}(?=[\\s"'?\\\\]|$)`).test(cmd) &&
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

/**
 * The BA door's writes: a suggestion on the room's requirement (`ba_suggest`), or a first
 * requirement proposed from a journey (`ba_suggest_requirement`). The door holds no other write, so
 * its true "I drafted r2 of REQ-32" rests on one of them (QA on forge-dev 2026-10-08, REQ-32's room:
 * the claim was held with only the chat's requirement tools known, and no rewrite could pass).
 */
const BA_REQUIREMENT_WRITES = ['ba_suggest', 'ba_suggest_requirement'] as const;

/** Whether the turn wrote the requirement `ref` names: any draft, a revision of that REQ, a BA suggestion, or a REST POST. */
function requirementWritten(calls: readonly Call[], ref: string | null): boolean {
  return writes(calls).some((c) => {
    if (named(c, 'forge_requirement_draft') || restPost(c, 'requirements')) return true;
    if (BA_REQUIREMENT_WRITES.some((tool) => named(c, tool))) return true;
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
  for (const { body, question } of sentences(text)) {
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
        why: `reply claims ${what} was recorded${c.ref ? ` (${c.ref})` : ''} but this turn made no ${c.kind === 'feedback' ? '`forge_feedback` call or POST to the feedback route' : "requirement write (`forge_requirement_draft`, `forge_requirement_revise`, at a requirement's BA door `ba_suggest` or `ba_suggest_requirement`, or a POST to the requirements route) that succeeded"}`,
      });
    }
  }
  return breaks;
}

/** Every claim to have shared an answer or saved a report that this turn's writes do not carry. */
function ungroundedSharesAndSaves(text: string, calls: readonly Call[]): RuleBreak[] {
  const breaks: RuleBreak[] = [];
  const shared = writes(calls).some((c) => restPostExact(c, 'shares'));
  const saved = writes(calls).some(
    (c) => named(c, 'forge_template_save') || restPostExact(c, 'status/reports'),
  );
  for (const { body, question } of sentences(text)) {
    if (question || !body) continue;
    if (!shared && (SHARE_EN.test(body) || SHARE_VI.test(body))) {
      breaks.push({
        quote: body,
        why: 'reply claims the answer was shared, and this turn created no share (POST /api/projects/<id>/shares): offer to make the link instead of saying it exists',
      });
    }
    if (!saved && claimsSave(body)) {
      breaks.push({
        quote: body,
        why: 'reply claims a report was saved, and this turn saved none: call forge_template_save with the template run (in Agent mode, POST /api/projects/<id>/status/reports), or offer to save it instead of saying it is saved',
      });
    }
  }
  if (!shared && SHARE_TOKEN_RE.test(text)) {
    breaks.push({
      quote: null,
      why: 'reply holds a share link, and this turn created no share: a link is never written by hand',
    });
  }
  return breaks;
}

/** A claim to have created a record, held to what the turn wrote; a claim to have created an issue is always false from chat. */
export const CREATION_CLAIMS_GROUNDED: MessageRule = {
  id: 'creation-claims-grounded',
  shape:
    'say a record was made, an answer shared or a report saved only where this turn did it: Feedback or a Requirement draft, never an issue; a share only after its POST, a saved report only after forge_template_save or its POST',
  example: 'I have not recorded anything yet; tell me to and I will record it as Feedback.',
  needs: ['prefixes'],
  check: (text, f) => {
    const breaks = [
      ...ungroundedRecords(text, f.toolCalls),
      ...ungroundedSharesAndSaves(text, f.toolCalls),
    ];
    if (claimsIssueCreated(text, f.prefixes)) {
      breaks.push({
        quote: null,
        why: 'reply claims an issue was created, and chat cannot create one (CHAT_FILES_FEEDBACK_NOT_ISSUES): it records Feedback or a Requirement draft',
      });
    }
    return breaks;
  },
};
