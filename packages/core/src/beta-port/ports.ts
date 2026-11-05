// What the beta port reaches in the design context, which the work context may not import (ISS-982):
// filing a ported beta issue as a Feedback item through the feedback module's own creation path, and
// reading what that item's triage made of it. The composition root provides both at boot.

import type {
  CreateFeedbackRequest,
  FeedbackRoute,
  FeedbackStatus,
} from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { portSlot } from '../lib/port-slot.js';
import type { Refusal } from '../lib/refusal.js';

/** What a ported item's triage made of it, read from the item's own record. */
export interface PortedTriage {
  key: string;
  status: FeedbackStatus;
  route: FeedbackRoute | null;
  answer: string | null;
  /** The issues an issue route names, oldest first. */
  issueIds: string[];
}

interface BetaPortPorts {
  /** `feedback/index.ts:createFeedback`: the item filed, or the one already filed under `dedupKey`. */
  createFeedback: (input: {
    projectId: string;
    actor: { userId: string; agency: ActorAgency };
    request: CreateFeedbackRequest;
    dedupKey?: string | undefined;
  }) => Promise<
    | { ok: true; feedback: { id: string; key: string }; created?: boolean }
    | { ok: false; refusals: Refusal[] }
  >;
  /** `feedback/index.ts:triageOutcomesOf`. */
  triageOutcomesOf: (feedbackIds: readonly string[]) => Promise<Map<string, PortedTriage>>;
  /** `feedback/index.ts:feedbackIdOfSeq`. */
  feedbackIdOfSeq: (projectId: string, seq: number) => Promise<string | null>;
}

const slot = portSlot<BetaPortPorts>('beta-port', 'provideBetaPortPorts');
export const provideBetaPortPorts = slot.provide;
const { port } = slot;

export const createFeedback = port('createFeedback');
export const triageOutcomesOf = port('triageOutcomesOf');
export const feedbackIdOfSeq = port('feedbackIdOfSeq');
