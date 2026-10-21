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
}

const slot = portSlot<LessonsPorts>('lessons', 'provideLessonsPorts');
export const provideLessonsPorts = slot.provide;
export const lessonsPorts = slot.get;
