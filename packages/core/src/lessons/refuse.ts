import type { LessonRefusalCode } from '@forge/contracts/lessons';
import { refuser } from '../lib/refusal.js';

/** The lessons module's thrower: every refusal names what was wrong and the valid shape. */
export const refuse = refuser<LessonRefusalCode>('LESSON_REFUSED');
