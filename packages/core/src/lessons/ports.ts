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
}

const slot = portSlot<LessonsPorts>('lessons', 'provideLessonsPorts');
export const provideLessonsPorts = slot.provide;
export const lessonsPorts = slot.get;
