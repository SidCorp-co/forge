// The ports of what a lesson reads, filled once at boot by the process entry (ADR 0008): a mockup's
// correction through the mockup's own view, never its table, and a room writer's Forge user through
// the room (REQ-50 BC-1); the change a landing made; and the capability card a lesson folds into,
// with its scenarios and the paths its door lives in, from the door catalog and the scenario registry
// (ISS-1251).

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
  });
}
