/**
 * What every onboarding write shares: who acts, the outcome it answers, the project lock it runs
 * under and the read-back after it commits.
 */

import type { OnboardingView } from '@forge/contracts/onboarding';
import type { ActorAgency } from '@forge/contracts/permissions';
import { appendMessagesIn } from '../conversations/index.js';
import { db, type TxOnly } from '../db/client.js';
import { lockXact } from '../lib/advisory-lock.js';
import type { Refusal } from '../lib/refusal.js';
import {
  actorFor,
  type PermissionFacts,
  permissionFactsOf,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import { onboardingOf, onboardingView } from './read.js';

export interface OnboardingActor {
  userId: string;
  agency: ActorAgency;
}

export type OnboardingOutcome =
  | { ok: true; onboarding: OnboardingView; created?: boolean }
  | { ok: false; refusals: Refusal[] };

/** The project read every act needs, then the rule its actor is held to. */
export async function refusalFor(
  actor: OnboardingActor,
  projectId: string,
  rule: (facts: PermissionFacts) => Refusal | null,
): Promise<Refusal | null> {
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  return rule(await permissionFactsOf(actor.userId, projectId));
}

/** Serialises every onboarding write on one project. */
export async function lockOnboarding(tx: TxOnly, projectId: string) {
  await lockXact(tx, 'onboarding', projectId);
}

export async function settled(
  projectId: string,
  extra: { created?: boolean } = {},
): Promise<OnboardingOutcome> {
  const row = await onboardingOf(db, projectId);
  if (!row) throw new Error(`onboarding: project ${projectId} lost its onboarding after a write`);
  return { ok: true, onboarding: await onboardingView(db, row), ...extra };
}

export async function systemLine(tx: TxOnly, conversationId: string, content: string) {
  await appendMessagesIn(tx, {
    conversationId,
    messages: [{ role: 'system', content, authorLabel: 'Forge' }],
  });
}
