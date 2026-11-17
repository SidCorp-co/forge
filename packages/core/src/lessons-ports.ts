// The ports of what a lesson reads, filled once at boot by the process entry (ADR 0008): a mockup's
// correction through the mockup's own view, never its table, and a room writer's Forge user through
// the room (REQ-50 BC-1); the change a landing made; and the capability card a lesson folds into,
// with its scenarios and the paths its door lives in, from the door catalog and the scenario registry
// (ISS-1251).

import { LESSON_ANCHOR_RE } from '@forge/contracts/lessons';
import { provideLessonsPorts } from './lessons/index.js';
import { cardPaths, doorCatalog } from './lib/door-catalog.js';
import { cardTextOf } from './mcp/index.js';
import { memoryIssueSide } from './memory-issue-reads.js';
import { getMockupAs } from './mockups/index.js';
import { roomWriterUserId } from './support/index.js';

export function provideLessonDomainPorts(): void {
  provideLessonsPorts({
    mockupOf: async (projectId, mockupId, viewer) =>
      (await getMockupAs(viewer, projectId, mockupId)) ?? null,
    roomWriterOf: roomWriterUserId,
    landedChange: memoryIssueSide.landedChange,
    cardOf: async (cardId) => {
      const card = doorCatalog().doors.find((d) => d.card?.id === cardId)?.card;
      return card ? cardTextOf(card) : null;
    },
    cardPaths: async (cardId) => cardPaths(cardId),
    cardsLike: async (text, limit) => cardsNear(text, limit),
    issueKeyOf: async (issueId) =>
      (await memoryIssueSide.displayIds([issueId])).get(issueId) ?? null,
  });
}

const wordsOf = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );

interface NearCard {
  id: string;
  purpose: string;
  situations: readonly { when: string; do: string }[];
}

/**
 * The cards nearest `text`, nearest first, by the words they share with it, each word weighed by how
 * few cards say it (inverse document frequency). Counted raw, the longest cards led every list for
 * any lesson, a word every card says ("agent", "project", "issue") counting as much as the one that
 * names the subject; the anchor and settle prompts offer only these, so a lesson about a beta link
 * was offered the cards that say most, never the one about it (ISS-1251 c4).
 */
export function nearestCards(
  cards: readonly NearCard[],
  text: string,
  limit: number,
): { id: string; purpose: string }[] {
  const said = cards.map((card) => ({
    card,
    words: wordsOf(
      [card.id, card.purpose, ...card.situations.map((s) => `${s.when} ${s.do}`)].join(' '),
    ),
  }));
  const saying = new Map<string, number>();
  for (const { words } of said) for (const w of words) saying.set(w, (saying.get(w) ?? 0) + 1);
  const weight = (w: string) => Math.log((said.length + 1) / ((saying.get(w) ?? 0) + 1));
  const wanted = [...wordsOf(text)];
  return said
    .map(({ card, words }) => ({
      card,
      score: wanted.filter((w) => words.has(w)).reduce((n, w) => n + weight(w), 0),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1))
    .slice(0, limit)
    .map(({ card }) => ({ id: card.id, purpose: card.purpose }));
}

/** The anchorable cards nearest `text`, nearest first. */
const cardsNear = (text: string, limit: number) =>
  nearestCards(
    doorCatalog().doors.flatMap((d) =>
      d.card && LESSON_ANCHOR_RE.test(`card:${d.card.id}`) ? [d.card] : [],
    ),
    text,
    limit,
  );
