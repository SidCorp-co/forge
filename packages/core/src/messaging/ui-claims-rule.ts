/**
 * The rule that holds a reply's claim to have moved the page beside the chat against what the turn
 * actually did (REQ-41 BC-4, BC-6; ISS-495).
 *
 * A page action is a tool call the browser then applies (`ui-actions-tool.ts`). "Requirements is open
 * and filtered to show only items waiting on you" is true only where this turn made that call and
 * core forwarded it. QA of dev.220: every `ui_requirements_filter` call came back refused, and chat
 * said it had opened and filtered the list anyway. A sentence that claims an act of one kind (open a
 * page, set a filter, highlight a section) is held to a call of that kind in this turn that was not
 * refused; one that was refused, or never made, grounds nothing, and the clause is cut like any
 * other claim the turn cannot back (`reply-marks.ts:cutClauses`).
 *
 * Read as an act, not as a topic: a completed or standing form ("opened", "is open", "filtered",
 * "highlighted") in a sentence naming a page or a list. A negation, a refusal reported as one
 * ("the filter was refused"), a modal or conditional, and a question claim nothing. An open claim
 * needs a page noun or a list name, so "I opened ISS-12 and read its plan" is no claim about the page.
 */

// every Vietnamese literal here is an `i18n-allow` pragma carrying the phrasing the detector must read; people chat in Vietnamese.

import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';

type Call = MessageFacts['toolCalls'][number];
type Act = 'open' | 'filter' | 'highlight';

const LISTS =
  /\b(?:requirements?|feedback|workflows?|releases?|issues|overview|pipeline|agents|ecosystem|schedules|improvements|settings)\b/iu;
const PAGE_NOUN = /\b(?:list|page|tab|view|screen|board|panel|beside the chat)\b/iu;

const OPEN_EN =
  /\b(?:(?:I|we)(?:'ve|’ve| have| just)?\s+(?:just\s+|now\s+)?(?:opened|navigated|switched|taken|brought)|(?:is|are|was|now)\s+(?:now\s+)?open(?:ed)?|has\s+been\s+opened|(?:opened|navigated|switched)\s+(?:to|the|your|over|you))\b/iu;
const OPEN_VI = /(?:đã|vừa)\s+mở\b|đang\s+mở\b/iu; // i18n-allow: the Vietnamese phrasing of an open claim being policed

const FILTER_EN =
  /\b(?:(?:I|we)(?:'ve|’ve| have| just)?\s+(?:just\s+|now\s+)?(?:filtered|narrowed|set\s+(?:the|a|your)\s+(?:\w+\s+)?filter|applied\s+(?:the|a|your)\s+(?:\w+\s+)?filter)|(?:is|are|was|now)\s+(?:now\s+)?(?:filtered|narrowed)|(?:filter|filters)\s+(?:is|are|has\s+been|have\s+been)\s+(?:now\s+)?(?:set|applied)|(?:filtered|narrowed)\s+(?:to|down|by)|showing\s+only|shows?\s+only)\b/iu;
const FILTER_VI = /(?:đã|vừa)\s+(?:lọc|áp\s+dụng\s+bộ\s+lọc|đặt\s+bộ\s+lọc)|đang\s+lọc\b/iu; // i18n-allow: the Vietnamese phrasing of a filter claim being policed

const HIGHLIGHT_EN =
  /\b(?:(?:I|we)(?:'ve|’ve| have| just)?\s+(?:just\s+|now\s+)?(?:highlighted|marked|pointed\s+(?:you\s+)?to|scrolled)|(?:is|are|was|now)\s+(?:now\s+)?(?:highlighted|marked)|has\s+been\s+highlighted|highlighting\s+(?:the|its|it|that|your)\b)/iu;
const HIGHLIGHT_VI = /(?:đã|vừa)\s+(?:đánh\s+dấu|làm\s+nổi\s+bật|tô\s+sáng)/iu; // i18n-allow: the Vietnamese phrasing of a highlight claim being policed

/** Words that say the act did not happen, was refused, or is only possible or conditional: nothing is claimed. */
const NOT_CLAIMED =
  /\b(?:not|never|no|couldn't|could not|can't|cannot|can not|didn't|did not|wasn't|was not|isn't|aren't|unable|failed|fails|refus(?:ed|al|es)|rejected|declined|will|would|could|can|may|might|if|once|when|whenever|unless|whether|want|wants|like|shall|should|let me)\b|n['’]t\b|(?:chưa|không|sẽ|có\s+thể|nếu|khi)\s/iu; // i18n-allow: the Vietnamese negating and conditional words

const ACTS: Record<Act, { en: RegExp; vi: RegExp; calls: (name: string) => boolean }> = {
  open: {
    en: OPEN_EN,
    vi: OPEN_VI,
    calls: (n) => n === 'ui_open' || n === 'ui_navigate' || /^ui_[a-z]+_filter$/u.test(n),
  },
  filter: { en: FILTER_EN, vi: FILTER_VI, calls: (n) => /^ui_[a-z]+_filter$/u.test(n) },
  highlight: { en: HIGHLIGHT_EN, vi: HIGHLIGHT_VI, calls: (n) => n === 'ui_highlight' },
};

const wireName = (c: Call): string => c.name.replace(/^.*__(?=ui_)/u, '');

const sentences = (text: string): { body: string; question: boolean }[] =>
  [...text.matchAll(/([^.!?\n;]+)([.!?\n;]|$)/gu)].map((m) => ({
    body: (m[1] ?? '').trim(),
    question: m[2] === '?',
  }));

/** The acts one sentence claims. */
function claimed(body: string): Act[] {
  if (NOT_CLAIMED.test(body)) return [];
  const onPage = LISTS.test(body) || PAGE_NOUN.test(body);
  return (Object.keys(ACTS) as Act[]).filter((act) => {
    const { en, vi } = ACTS[act];
    if (!(en.test(body) || vi.test(body))) return false;
    return act === 'open' ? onPage : true;
  });
}

const WHAT: Record<Act, string> = {
  open: 'opened a page',
  filter: 'set a list filter',
  highlight: 'highlighted something on the page',
};

/** Every sentence claiming a page act that this turn made no unrefused call of that kind for. */
function ungroundedPageActs(text: string, calls: readonly Call[]): RuleBreak[] {
  const breaks: RuleBreak[] = [];
  for (const { body, question } of sentences(text)) {
    if (question || !body) continue;
    for (const act of claimed(body)) {
      const made = calls.filter((c) => ACTS[act].calls(wireName(c)));
      if (made.some((c) => !c.isError)) continue;
      const why =
        made.length > 0
          ? `every ${act === 'highlight' ? 'highlight' : act === 'filter' ? 'filter' : 'open'} call this turn was refused`
          : 'this turn made no such call';
      breaks.push({
        quote: body,
        why: `reply claims the page ${WHAT[act]}, but ${why}: a page action reaches the page only when its call is accepted, so say what was refused or leave the claim out.`,
      });
      break;
    }
  }
  return breaks;
}

/** A claim to have opened a page, set a filter or highlighted something, held to the page calls the turn made that were not refused. */
export const UI_ACTS_GROUNDED: MessageRule = {
  id: 'ui-acts-grounded',
  shape:
    "say a page was opened, a filter set or something highlighted only where this turn's call for it was accepted; where it was refused, say what was refused",
  example: 'The page action was refused, so nothing on the page changed.',
  needs: [],
  check: (text, f) => ungroundedPageActs(text, f.toolCalls),
};
