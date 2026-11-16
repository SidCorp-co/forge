// forge_support's description, rendered from the room acts' capability cards (ISS-1251): each act's
// entry is its signature and its card's purpose, and `forge_describe` answers the card beside it, so
// the card is the one text that teaches the act. An act no card covers yet keeps its own entry here
// until its card lands, and an act holding both is a build error by name: the entry is deleted in the
// change that adds the card, never kept as a second copy beside it.

import { capabilityCardSchema } from '@forge/contracts/capability-cards';
import { SUPPORT_ACT_CARDS, type SupportAction } from './act-cards.js';
import { AUDIT_RUBRIC_TEXT } from './reply-audit/teach.js';

/**
 * The entries of the acts no card covers yet, each what the act does in a sentence or two. An act's
 * entry goes when its card lands (`supportToolDescription` refuses both).
 */
export const UNCARDED_ENTRIES: Readonly<Partial<Record<SupportAction, string>>> = {};

/** What an act's entry carries beyond its card's purpose: data the act is scored or called by. */
const DERIVED: Readonly<Partial<Record<SupportAction, string>>> = {
  audit: AUDIT_RUBRIC_TEXT,
};

/** What every act shares, said once before the entries. */
const LEAD = [
  'Answer a Rocket.Chat support group, or an operations room, as its assistant. Every answer people see goes through this tool; nothing you write outside it reaches the room.',
  "Each act's card, read with forge_describe, says when to reach for it and how; an act your room is not granted, or a project outside its scope, is refused by name and posts nothing: hand it to the project's master with ask_master, or raise the grant with technical.",
];

/** `name { args }` of each act, as its listed shape names it, its parenthesised note left out. */
export function signaturesOf(shape: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of shape) {
    const m = /^([a-z_]+) \{/.exec(s);
    if (!m?.[1]) continue;
    out.set(m[1], s.replace(/\s*\([^{}]*\)$/, ''));
  }
  return out;
}

/** Each act's entry, `name { args }: what it does`: its card's purpose, or its own where no card covers it yet. */
export function supportActEntries(
  actions: readonly SupportAction[],
  shape: readonly string[],
): Record<string, string> {
  const signatures = signaturesOf(shape);
  const entries: Record<string, string> = {};
  for (const act of new Set(actions)) {
    const signature = signatures.get(act);
    if (!signature) {
      throw new Error(`support: forge_support lists no shape for ${act} (support/tool.ts SIGNATURES)`);
    }
    const body = SUPPORT_ACT_CARDS[act];
    const own = UNCARDED_ENTRIES[act];
    if (body && own) {
      throw new Error(
        `support: ${act} has a card and an entry of its own in forge_support's description: delete its entry (support/tool-description.ts UNCARDED_ENTRIES), the card teaches it`,
      );
    }
    if (body) {
      const card = capabilityCardSchema.parse(body);
      entries[act] = `${signature}: ${card.purpose}${DERIVED[act] ? ` ${DERIVED[act]}` : ''}`;
    } else if (own) {
      entries[act] = `${signature}: ${own}`;
    } else {
      throw new Error(
        `support: ${act} has neither a card (support/act-cards.ts) nor an entry (support/tool-description.ts), so forge_describe has nothing to teach it by`,
      );
    }
  }
  return entries;
}

/**
 * The description: the lead, the notes every act shares and the refusal's shape, then each act's
 * entry. forge_describe reads each entry alone (`McpTool.actionEntries`), never out of this text.
 */
export function supportToolDescription(
  entries: Readonly<Record<string, string>>,
  notes: readonly string[],
): string {
  return [
    ...LEAD,
    `${notes.join('; ')}.`,
    'A refusal answers { error: { code, message, refusals: [{ code, path, detail }] } } and posts nothing.',
    ...Object.values(entries),
  ].join(' ');
}
