// feedback-triage `verify-ask`: an ask to verify a resolved item reaches its reporter's bell, and the
// verify or reopen of that item settles it.

import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';

const verifyKey = (feedbackId: string) => `feedback-verify:${feedbackId}`;

async function asked(p: Payload<'feedback.verifyAsked'>, eventId: string): Promise<void> {
  await emitNotification({
    recipients: [p.reporter],
    projectId: p.projectId,
    type: 'feedback_verify_asked',
    title: `${p.key} is resolved: ${p.title}`,
    body: 'The work your feedback asked for has shipped. Verify the fix, or reopen the item saying what it does not answer.',
    resolutionKey: verifyKey(p.feedbackId),
    dedupeKey: `feedback-verify-ask:${eventId}`,
  });
}

async function settled(p: Payload<'feedback.verifySettled'>): Promise<void> {
  await resolveNotifications(verifyKey(p.feedbackId), `${p.key} ${p.decision}`);
}

export function registerFeedbackNotifications(): void {
  const name = 'notify-feedback';
  consume('feedback.verifyAsked', { name, handle: (p, d) => asked(p, d.eventId) });
  consume('feedback.verifySettled', { name, handle: settled });
}
