/** The guards of the triage verbs that are not a route, and of messages: pure functions over what the service read (workflow feedback-triage `decide`). */

import type { FeedbackPhase, FeedbackStatus } from '@forge/contracts/feedback';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';
import { type FeedbackRefusal, refusal } from './rules.js';

/** Accepting moves a new or reopened item to triaged and writes no route. */
export function acceptRefusal(phase: FeedbackPhase): FeedbackRefusal | null {
  if (phase === 'new' || phase === 'reopened') return null;
  return refusal(
    'FEEDBACK_STATUS_INVALID',
    '/status',
    `the item reads ${phase}; only a new or reopened item is accepted. Route it, or ask for what it still lacks.`,
  );
}

/** A snooze is a reason and a future date within the limit, on an item still waiting in New. */
export function snoozeRefusal(
  phase: FeedbackPhase,
  until: Date,
  reason: string | undefined,
  now: Date,
  maxDays: number,
): FeedbackRefusal | null {
  if (!reason?.trim()) {
    return refusal(
      'FEEDBACK_SNOOZE_REASON_REQUIRED',
      '/reason',
      'a snoozed item says why; the triager who sees it return reads the reason.',
    );
  }
  if (phase !== 'new' && phase !== 'reopened') {
    return refusal(
      'FEEDBACK_STATUS_INVALID',
      '/status',
      `the item reads ${phase}; only a new or reopened item is snoozed, because a snooze returns it to New.`,
    );
  }
  if (Number.isNaN(until.getTime())) {
    return refusal(
      'FEEDBACK_SNOOZE_PAST',
      '/until',
      'the date is not a date; send an ISO 8601 date-time still to come.',
    );
  }
  if (until.getTime() <= now.getTime()) {
    return refusal(
      'FEEDBACK_SNOOZE_PAST',
      '/until',
      `${until.toISOString()} is not after now (${now.toISOString()}); a snooze returns the item to New on a date still to come.`,
    );
  }
  if (until.getTime() > now.getTime() + maxDays * 86_400_000) {
    return refusal(
      'FEEDBACK_SNOOZE_TOO_FAR',
      '/until',
      `${until.toISOString()} is more than ${maxDays} days away; an item parked that long is forgotten, so decline it or snooze it to a nearer date.`,
    );
  }
  return null;
}

/** Writing an internal note takes project.write, the membership every reporter and triager holds. */
export const noteActRefusal = (facts: PermissionFacts) =>
  permissionRefusal(facts, 'project.write', 'writing an internal note');

/** A message says something, and a message to reporters reaches at least one who has a bell. */
export function messageRefusal(
  audience: 'reporter' | 'all_reporters' | 'internal',
  text: string,
  reached: number,
  relayed = false,
): FeedbackRefusal | null {
  if (!text.trim()) {
    return refusal(
      'FEEDBACK_MESSAGE_EMPTY',
      '/text',
      relayed
        ? 'a relay records what you told the reporter; the text is empty.'
        : 'a message says something; the text is empty.',
    );
  }
  if (relayed && audience === 'internal') {
    return refusal(
      'FEEDBACK_RELAY_NOT_TO_REPORTERS',
      '/relayed',
      'a relay records what you told reporters outside Forge, and an internal note is told to nobody; pick reporter or all_reporters, or drop relayed.',
    );
  }
  if (!relayed && audience !== 'internal' && reached === 0) {
    return refusal(
      'FEEDBACK_MESSAGE_NO_RECIPIENT',
      '/audience',
      audience === 'reporter'
        ? 'this reporter has no bell to tell (an agent, or a reporter Forge cannot reach); tell them where they listen and send it with relayed: true to record it, or write an internal note.'
        : 'none of the reporters merged into this item has a bell to tell; tell them where they listen and send it with relayed: true to record it, or write an internal note.',
    );
  }
  return null;
}

// duplicate_of names a root that is not itself a duplicate, and an item other items point
// at never becomes a duplicate (FEEDBACK_DUPLICATE_CHAIN); an item is never its own (FEEDBACK_DUPLICATE_SELF)
export function duplicateRefusal(
  selfId: string,
  root: { id: string; key: string; status: FeedbackStatus; duplicateOfKey: string | null },
  pointedAtBy: readonly string[],
): FeedbackRefusal | null {
  if (root.id === selfId) {
    return refusal(
      'FEEDBACK_DUPLICATE_SELF',
      '/duplicateOf',
      'an item is not a duplicate of itself.',
    );
  }
  // a declined root is an item that will not be done: its reporters would be told their report
  // follows an item that follows nothing
  if (root.status === 'declined') {
    return refusal(
      'FEEDBACK_DUPLICATE_OF_DECLINED',
      '/duplicateOf',
      `${root.key} was declined, so an item that follows it follows nothing; decline this one with its own reason, or name an item that is still open.`,
    );
  }
  if (root.duplicateOfKey) {
    return refusal(
      'FEEDBACK_DUPLICATE_CHAIN',
      '/duplicateOf',
      `${root.key} is itself a duplicate of ${root.duplicateOfKey}; point at the root, ${root.duplicateOfKey}.`,
    );
  }
  if (pointedAtBy.length > 0) {
    return refusal(
      'FEEDBACK_DUPLICATE_CHAIN',
      '/duplicateOf',
      `${pointedAtBy.join(', ')} ${pointedAtBy.length === 1 ? 'is a duplicate' : 'are duplicates'} of this item, so it stays a root; mark ${root.key} a duplicate of this one instead.`,
    );
  }
  return null;
}
