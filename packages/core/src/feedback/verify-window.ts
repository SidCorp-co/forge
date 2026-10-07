import { FEEDBACK_VERIFY_WINDOW } from '@forge/contracts/feedback';
import { readProjectDocument } from '../project-config/index.js';

const DAY_MS = 86_400_000;

/** The moment Forge verifies an item first read resolved at `seenAt`, for a window of `days`. */
export const autoVerifyAt = (seenAt: Date, days: number) =>
  new Date(seenAt.getTime() + days * DAY_MS);

/** The project's verify window in days: its `feedback.verifyWindowDays`, else the default. */
export async function verifyWindowDays(projectId: string): Promise<number> {
  const held = await readProjectDocument(projectId);
  return held?.document.feedback?.verifyWindowDays ?? FEEDBACK_VERIFY_WINDOW.defaultDays;
}
