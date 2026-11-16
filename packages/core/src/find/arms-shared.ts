// The find door's arms over what is not one project's row (ISS-1256): the capability cards every
// project shares (ISS-1251, read from the served door catalog), one room's transcript (whose own fence
// decides who reads it), and the glossary's alias matches, each naming its term outright.

import { searchConversationTranscript } from '../conversations/index.js';
import { doorCatalog } from '../lib/door-catalog.js';
import { type Candidate, hitId } from './candidate.js';
import { normalized } from './expand.js';
import type { GlossaryTerm } from './model-reads.js';

/** Words shorter than this name nothing a card is found by. */
const MIN_WORD = 3;

/**
 * The cards whose door, purpose, situations or practice hold half the expanded query's words or
 * more, the most words held first. A card is Forge's, so it belongs to no project.
 */
export function capabilityArm(text: string, limit: number): Candidate[] {
  const words = [
    ...new Set(
      normalized(text)
        .split(' ')
        .filter((w) => w.length >= MIN_WORD),
    ),
  ];
  if (words.length === 0) return [];
  // half the words at least, so one common word ("run") does not bring every card
  const enough = Math.ceil(words.length / 2);
  const found: Candidate[] = [];
  for (const door of doorCatalog().doors) {
    const card = door.card;
    if (!card) continue;
    const said = [
      card.purpose,
      ...card.situations.flatMap((s) => [s.when, s.do]),
      ...card.practice,
    ].join(' ');
    const held = ` ${normalized(`${card.id} ${said}`)} `;
    const score = words.filter((w) => held.includes(` ${w} `)).length;
    if (score < enough) continue;
    found.push({
      id: hitId('capability', card.id),
      type: 'capability',
      ref: card.id,
      key: card.id,
      title: card.purpose,
      text: card.situations.map((s) => `When ${s.when} → ${s.do}`).join('\n'),
      projectId: null,
      status: null,
      placed: null,
      score,
      arm: 'keyword',
    });
  }
  return found.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref)).slice(0, limit);
}

/** One room's indexed passages matching the query, read under the room's own fence. */
export async function conversationArm(input: {
  conversationId: string;
  userId: string;
  projectId: string;
  query: string;
  limit: number;
}): Promise<{ hits: Candidate[]; limitation: string | null }> {
  const found = await searchConversationTranscript({
    conversationId: input.conversationId,
    userId: input.userId,
    query: input.query,
    limit: input.limit,
  });
  return {
    limitation: found.limitation,
    hits: found.matches.map((m) => ({
      id: hitId('conversation', m.passageId),
      type: 'conversation',
      ref: m.passageId,
      key: `${input.conversationId}#${m.firstSeq}-${m.lastSeq}`,
      title: `Messages ${m.firstSeq}–${m.lastSeq}`,
      text: m.text,
      projectId: input.projectId,
      status: m.stillOpen ? 'open' : null,
      placed: null,
      score: 0,
      arm: 'keyword',
      native: m,
    })),
  };
}

/** Each term the glossary matched, as the alias arm ranks it: in the order the terms matched. */
export function aliasArm(named: readonly { term: GlossaryTerm; alias: string }[]): Candidate[] {
  return named.map(({ term, alias }) => ({
    id: hitId('term', term.id),
    type: 'term',
    ref: term.id,
    key: term.slug,
    title: term.title,
    text: term.body,
    projectId: term.projectId,
    status: 'in force',
    placed: { kind: 'knowledge', id: term.id },
    score: 1,
    arm: 'alias',
    alias,
  }));
}
