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

/** The anchorable cards nearest `text` by the words they share with it, nearest first. */
function cardsNear(text: string, limit: number): { id: string; purpose: string }[] {
  const wanted = wordsOf(text);
  return doorCatalog()
    .doors.flatMap((d) => (d.card && LESSON_ANCHOR_RE.test(`card:${d.card.id}`) ? [d.card] : []))
    .map((card) => {
      const said = wordsOf(
        [card.id, card.purpose, ...card.situations.map((s) => `${s.when} ${s.do}`)].join(' '),
      );
      return { card, score: [...wanted].filter((w) => said.has(w)).length };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || (a.card.id < b.card.id ? -1 : 1))
    .slice(0, limit)
    .map(({ card }) => ({ id: card.id, purpose: card.purpose }));
}
