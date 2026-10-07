/**
 * A claim about how the project stands — what shipped, how far a requirement is, what comes next,
 * what is late, what was decided — has to rest on a read the turn actually made (JU-1). The
 * assistant answered such questions from issue counts and memory, and they were wrong — lateness
 * above all is the forecast's, which no issue count says; the read
 * tools that answer them exist now, so a reply making the claim with none of them called this
 * turn, or with every such call refused, is sent back to call one. Where the turn was offered none
 * of them (agent mode, a door without the project toolset) the rule has nothing to hold it to and
 * does not judge.
 *
 * A memory is a dated source, never a current fact (MJ-5). It never grounds what shipped, how far a
 * requirement is, what comes next or what is late. A decision taken from a memory read this turn is
 * grounded only when the reply names the date that memory speaks as of — "a memory of 2026-10-04
 * records that…" — so the reader can see it is a record of then, not a reading of now.
 */

// every Vietnamese regex below carries its `i18n-allow` pragma on its own line: the language gate reads it same-line only.

import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';

/** The read tools a status claim rests on, by the names a chat turn calls them. */
export const GROUNDING_TOOLS = {
  status: 'forge_project_status',
  requirements: 'forge_requirements',
  requirement: 'forge_requirement',
  releases: 'forge_releases',
  release: 'forge_release',
  decisions: 'forge_decisions',
} as const;

/** The chat's memory read; it grounds only a decision, and only one cited with its date. */
export const MEMORY_TOOL = 'forge_memory';

interface ClaimFamily {
  readonly name: string;
  readonly patterns: readonly RegExp[];
  /** Tools whose successful read grounds this family. */
  readonly groundedBy: readonly string[];
  /** A memory read grounds this family when the reply names the memory's date. */
  readonly datedMemoryGrounds?: true;
}

const { status, requirements, requirement, releases, release, decisions } = GROUNDING_TOOLS;

const FAMILIES: readonly ClaimFamily[] = [
  {
    name: 'what shipped or was released',
    patterns: [
      /\b(?:shipped|went live|reached (?:the )?users|released (?:to|in|on|as)|was released|were released|has been released|have been released)\b/i,
      /\brelease[ds]?\s+v?\d+\.\d+/i,
      /\b(?:awaiting|waits? (?:on|for)|waiting (?:on|for)) (?:release )?approval\b/i,
      /đã\s+phát\s+hành|(?:tới|đến)\s+(?:tay\s+)?người\s+dùng|bản\s+phát\s+hành|đã\s+ra\s+mắt|chờ\s+(?:phê\s+)?duyệt/i, // i18n-allow: the Vietnamese phrasing of a shipped claim this rule reads
    ],
    groundedBy: [status, releases, release],
  },
  {
    name: "a requirement's progress",
    patterns: [
      /\brequirements?\b[^.\n]{0,60}\b(?:in progress|in delivery|delivered|accepted|agreed|done|complete[d]?|proven)\b/i,
      /\bREQ-\d+\b[^.\n]{0,80}\b(?:\d+\s*(?:\/|of)\s*\d+|in progress|in delivery|delivered|done|complete[d]?|proven|unproven)\b/i,
      /\b\d+\s*(?:\/|of)\s*\d+\s+(?:criteria|BCs?)\b/i,
      /yêu\s+cầu[^.\n]{0,60}(?:đang\s+(?:làm|giao|triển\s+khai)|đã\s+xong|hoàn\s+thành|đã\s+giao|in[_ ]progress|in[_ ]delivery)|\d+\s*\/\s*\d+\s+tiêu\s+chí/i, // i18n-allow: the Vietnamese phrasing of a requirement-progress claim this rule reads
    ],
    groundedBy: [status, requirements, requirement],
  },
  {
    name: 'what comes next and when',
    patterns: [
      /\b(?:roadmap|next release|forecast|ETA|expected (?:on|by|to (?:land|ship|reach))|will (?:ship|reach users|land) (?:on|by|in))\b/i,
      /lộ\s+trình|release\s+kế\s+tiếp|bản\s+kế\s+tiếp|dự\s+kiến/i, // i18n-allow: the Vietnamese phrasing of a roadmap claim this rule reads
    ],
    groundedBy: [status, releases, release, requirements, requirement],
  },
  {
    name: 'what is late or blocked',
    patterns: [
      /\b(?:is|are|running|currently)\s+(?:late|overdue|behind schedule)\b|\bnothing is late\b|\bno(?:thing)? (?:is )?(?:late|overdue|blocked)\b/i,
      /đang\s+trễ|bị\s+trễ|không\s+có\s+gì\s+trễ|bị\s+kẹt|đang\s+kẹt/i, // i18n-allow: the Vietnamese phrasing of a lateness claim this rule reads
    ],
    groundedBy: [status],
  },
  {
    name: 'what was decided',
    patterns: [
      /\bdecisions? (?:were|was|made|taken)\b|\b(?:was|were) decided\b|\bdecided (?:to|that|on)\b/i,
      /(?:các|những)\s+quyết\s+định\s+(?:đã|quan\s+trọng|gần\s+đây|nổi\s+bật|đáng\s+chú\s+ý|chính|được)|đã\s+chốt|đã\s+quyết\s+định|quyết\s+định\s+ngày/i, // i18n-allow: the Vietnamese phrasing of a decision claim this rule reads
    ],
    groundedBy: [decisions, requirement],
    datedMemoryGrounds: true,
  },
];

const ALL_GROUNDING: ReadonlySet<string> = new Set(Object.values(GROUNDING_TOOLS));

/** The first span of the text a family's patterns match, or null. */
function claimIn(text: string, family: ClaimFamily): string | null {
  for (const re of family.patterns) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}

/** The memory dates a read returned: `asOf`, `writtenAt` and `verifiedAt` on a memory hit. */
const MEMORY_DATE_RE = /"(?:asOf|writtenAt|verifiedAt)"\s*:\s*"(\d{4}-\d{2}-\d{2})T/g;

/** Every date (`YYYY-MM-DD`) a memory hit among these reads speaks as of. */
export function memoryDatesRead(texts: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(MEMORY_DATE_RE)) if (m[1]) out.add(m[1]);
  return out;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const MONTH_NAME = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';

/** The month and day (`MM-DD`) of every date a reply names: ISO, day/month, or a month by name. */
function monthDaysNamed(text: string): Set<string> {
  const out = new Set<string>();
  const md = (m: number, d: number) => {
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      out.add(`${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  };
  for (const m of text.matchAll(/\b\d{4}-(\d{2})-(\d{2})\b/g)) md(Number(m[1]), Number(m[2]));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g)) {
    md(Number(m[2]), Number(m[1]));
  }
  for (const m of text.matchAll(/(\d{1,2})\s+tháng\s+(\d{1,2})/gi)) md(Number(m[2]), Number(m[1])); // i18n-allow: the Vietnamese way of naming a date
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})\\b`, 'gi'))) {
    md(MONTHS.indexOf(m[1]?.toLowerCase() as (typeof MONTHS)[number]) + 1, Number(m[2]));
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+${MONTH_NAME}\\b`, 'gi'))) {
    md(MONTHS.indexOf(m[2]?.toLowerCase() as (typeof MONTHS)[number]) + 1, Number(m[1]));
  }
  return out;
}

/** Whether the reply names a date one of this turn's memory reads speaks as of. */
function citesMemoryDate(text: string, f: MessageFacts): boolean {
  if (f.memoryDates.size === 0) return false;
  const named = monthDaysNamed(text);
  for (const d of f.memoryDates) if (named.has(d.slice(5))) return true;
  return false;
}

/** Tools this turn read successfully. */
function readThisTurn(f: MessageFacts): Set<string> {
  return new Set(f.toolCalls.filter((c) => c.isError !== true).map((c) => c.name));
}

export const STATUS_CLAIMS_GROUNDED: MessageRule = {
  id: 'status-claims-grounded',
  shape:
    'state what shipped, how far a requirement is, what comes next, what is late or what was decided only from forge_project_status, forge_requirement(s), forge_release(s) or forge_decisions called this turn; a decision taken from forge_memory is cited with the date the memory speaks as of',
  example: 'I filed it as a draft; tell me if the title needs a change.',
  needs: [],
  check: (text, f) => {
    if (!f.offeredTools.some((t) => ALL_GROUNDING.has(t))) return [];
    const read = readThisTurn(f);
    const breaks: RuleBreak[] = [];
    for (const family of FAMILIES) {
      const quote = claimIn(text, family);
      if (!quote) continue;
      if (family.groundedBy.some((t) => read.has(t))) continue;
      const fromMemory = family.datedMemoryGrounds === true && read.has(MEMORY_TOOL);
      if (fromMemory && citesMemoryDate(text, f)) continue;
      breaks.push({
        quote,
        why: fromMemory
          ? `the reply states ${family.name} ("${quote}") from memory as if it held now — a memory is a record of its date: say "a memory of <its asOf date> records …", or call ${family.groundedBy.join(' or ')}`
          : `the reply states ${family.name} ("${quote}") and no read this turn grounds it — call ${family.groundedBy.join(' or ')} and answer from what it returns`,
      });
    }
    return breaks;
  },
};
