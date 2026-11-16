import type { MockupView } from '@forge/contracts/mockups';
import { portSlot } from '../lib/port-slot.js';
import type { CardScenario } from './scenario-replay.js';

// What lessons reads from the modules above it, handed in by the process entry at boot (ADR 0008:
// a domain imports only its own context or one before it). Read only inside a call.

interface LessonsPorts {
  /** One mockup as its own contract shows it, or null where the project holds no such mockup. A
   *  mockup's correction is read through this view alone, never the mockups module's table. */
  mockupOf(
    projectId: string,
    mockupId: string,
    viewer: { userId: string; agency: 'human' | 'agent' },
  ): Promise<MockupView | null>;
  /** The Forge user a room's writer is (a confirmed speaker link, or the chat server's verified
   *  address matching a Forge account's), or null where they are nobody Forge knows. */
  roomWriterOf(
    roomId: string,
    writer: { key: string; label: string | null },
  ): Promise<string | null>;
  /** What an issue's landing changed: its key, its words and its paths, or why none were read. */
  landedChange(
    projectId: string,
    issueId: string,
  ): Promise<{ key: string; text: string; paths: string[] | null; why?: string } | null>;
  /**
   * The capability card registry (ISS-1251 §1): a card by its id, with its scenarios and its current
   * text, or null where no door carries that card; and, where the registry knows them, the paths its
   * door lives in. Without paths, a card anchor is met by a landing naming the card.
   */
  cardOf(cardId: string): Promise<CardText | null>;
  cardPaths?(cardId: string): Promise<readonly string[]>;
}

/** A card as its code holds it now: its scenarios, and the text its surfaces render. */
export interface CardText {
  id: string;
  /** The replayable cases its `scenarios` names (`scenario-replay.ts`). */
  scenarios: readonly CardScenario[];
  /** What the card's audience reads every turn beside it (a room agent's map), where it teaches the card's situations too. */
  context?: string;
  situations: readonly { when: string; do: string; watch?: string | undefined }[];
  practice: readonly string[];
  redFlag?: string;
}

/** One delta a lesson that holds adds to or changes in its card (ADD, UPDATE), never a rewrite. */
export interface CardDelta {
  field: 'situation' | 'bestPractice' | 'redFlag';
  op: 'add' | 'update';
  text: string;
  /** For an update: the line it replaces, as the card holds it. */
  replaces?: string;
}

const slot = portSlot<LessonsPorts>('lessons', 'provideLessonsPorts');
export const provideLessonsPorts = slot.provide;
export const lessonsPorts = slot.get;
