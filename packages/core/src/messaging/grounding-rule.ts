/**
 * A claim about how the project stands — what shipped, how far a requirement is, what comes next,
 * what is late, what was decided — has to rest on a read the turn actually made (JU-1). The
 * assistant answered such questions from issue counts and memory, and they were wrong — lateness
 * above all is the forecast's, which no issue count says; the read
 * tools that answer them exist now, so a reply making the claim with none of them called this
 * turn, or with every such call refused, is sent back to call one. Where the turn was offered none
 * of them (agent mode, a door without the project toolset) the rule has nothing to hold it to and
 * does not judge.
 */

// every Vietnamese regex below carries its `i18n-allow` pragma on its own line: the language gate reads it same-line only.

import type { MessageRule, RuleBreak } from './contract.js';
import type { MessageFacts } from './facts.js';

/** The read tools a status claim rests on, by the names a chat turn calls them. */
export const GROUNDING_TOOLS = {
  status: 'forge_project_status',
  requirements: 'forge_requirements',
  releases: 'forge_releases',
  decisions: 'forge_decisions',
} as const;

interface ClaimFamily {
  readonly name: string;
  readonly patterns: readonly RegExp[];
  /** Tools whose successful read grounds this family. */
  readonly groundedBy: readonly string[];
}

const { status, requirements, releases, decisions } = GROUNDING_TOOLS;

const FAMILIES: readonly ClaimFamily[] = [
  {
    name: 'what shipped or was released',
    patterns: [
      /\b(?:shipped|went live|reached (?:the )?users|released (?:to|in|on|as)|was released|were released|has been released|have been released)\b/i,
      /\brelease[ds]?\s+v?\d+\.\d+/i,
      /\b(?:awaiting|waits? (?:on|for)|waiting (?:on|for)) (?:release )?approval\b/i,
      /đã\s+phát\s+hành|(?:tới|đến)\s+(?:tay\s+)?người\s+dùng|bản\s+phát\s+hành|đã\s+ra\s+mắt|chờ\s+(?:phê\s+)?duyệt/i, // i18n-allow: the Vietnamese phrasing of a shipped claim this rule reads
    ],
    groundedBy: [status, releases],
  },
  {
    name: "a requirement's progress",
    patterns: [
      /\brequirements?\b[^.\n]{0,60}\b(?:in progress|in delivery|delivered|accepted|agreed|done|complete[d]?|proven)\b/i,
      /\bREQ-\d+\b[^.\n]{0,80}\b(?:\d+\s*(?:\/|of)\s*\d+|in progress|in delivery|delivered|done|complete[d]?|proven|unproven)\b/i,
      /\b\d+\s*(?:\/|of)\s*\d+\s+(?:criteria|BCs?)\b/i,
      /yêu\s+cầu[^.\n]{0,60}(?:đang\s+(?:làm|giao|triển\s+khai)|đã\s+xong|hoàn\s+thành|đã\s+giao|in[_ ]progress|in[_ ]delivery)|\d+\s*\/\s*\d+\s+tiêu\s+chí/i, // i18n-allow: the Vietnamese phrasing of a requirement-progress claim this rule reads
    ],
    groundedBy: [status, requirements],
  },
  {
    name: 'what comes next and when',
    patterns: [
      /\b(?:roadmap|next release|forecast|ETA|expected (?:on|by|to (?:land|ship|reach))|will (?:ship|reach users|land) (?:on|by|in))\b/i,
      /lộ\s+trình|release\s+kế\s+tiếp|bản\s+kế\s+tiếp|dự\s+kiến/i, // i18n-allow: the Vietnamese phrasing of a roadmap claim this rule reads
    ],
    groundedBy: [status, releases, requirements],
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
      /(?:các|những)\s+quyết\s+định|đã\s+chốt|đã\s+quyết\s+định|quyết\s+định\s+ngày/i, // i18n-allow: the Vietnamese phrasing of a decision claim this rule reads
    ],
    groundedBy: [decisions, requirements],
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

/** Tools this turn read successfully. */
function readThisTurn(f: MessageFacts): Set<string> {
  return new Set(f.toolCalls.filter((c) => c.isError !== true).map((c) => c.name));
}

export const STATUS_CLAIMS_GROUNDED: MessageRule = {
  id: 'status-claims-grounded',
  shape:
    'state what shipped, how far a requirement is, what comes next, what is late or what was decided only from forge_project_status, forge_requirements, forge_releases or forge_decisions called this turn',
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
      breaks.push({
        quote,
        why: `the reply states ${family.name} ("${quote}") and no read this turn grounds it — call ${family.groundedBy.join(' or ')} and answer from what it returns`,
      });
    }
    return breaks;
  },
};
