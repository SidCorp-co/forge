import type { MockupView } from '@forge/contracts/mockups';
import { portSlot } from '../lib/port-slot.js';

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
   * The capability card registry (ISS-1251 §1), where one is provided: the paths a card's door lives
   * in, marking a card owed a re-check, and folding a lesson that holds into its card as one delta.
   * Absent, a card anchor is met by a landing naming it, and a lesson waiting to fold waits.
   */
  cardPaths?(cardId: string): Promise<readonly string[]>;
  cardRecheckOwed?(cardId: string, by: string): Promise<void>;
  foldIntoCard?(
    cardId: string,
    delta: CardDelta,
    by: string,
  ): Promise<{ ok: true } | { ok: false; why: string }>;
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
