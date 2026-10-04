import { registerReviewNotes } from './comments/index.js';
import { registerSourcePushReactions } from './ecosystem/index.js';
import { registerErrorSightings } from './error-intake/index.js';
import { registerHostMergeStamp } from './issues/index.js';
import {
  registerMemoryExtraction,
  registerMemoryIndexer,
  registerMemoryReconcileTrigger,
} from './memory/index.js';
import {
  registerNotifyMentionsSubscriber,
  registerTransitionNotifications,
} from './notifications/index.js';
import {
  registerActivitySubscribers,
  registerAnswerResume,
  registerPausedRunWedgeResolve,
  registerPhaseJournalClose,
  registerPipelineOrchestrator,
} from './pipeline/index.js';
import { registerPmSubscribers } from './pm/index.js';
import { registerLiveReadingInvalidation } from './projects/index.js';
import { registerReleaseBatchClaimSubscriber } from './release-batch/index.js';
import { registerWebhookSubscribers } from './webhooks/index.js';
import { registerMasterWakeSubscribers, registerWsBroadcastSubscribers } from './ws/index.js';

/**
 * Every consumer of the outbox, registered once before the worker starts, each under a name
 * `@forge/contracts/outbox-consumers:OUTBOX_CONSUMERS` declares. Each consumer has its own delivery
 * row per event, so the order here decides nothing.
 */
export function registerOutboxConsumers(): void {
  registerWsBroadcastSubscribers();
  registerActivitySubscribers();
  registerPipelineOrchestrator();
  registerAnswerResume();
  registerMasterWakeSubscribers();
  registerTransitionNotifications();
  registerNotifyMentionsSubscriber();
  registerWebhookSubscribers();
  registerPmSubscribers();
  registerPhaseJournalClose();
  registerPausedRunWedgeResolve();
  registerReleaseBatchClaimSubscriber();
  registerMemoryIndexer();
  registerMemoryReconcileTrigger();
  registerMemoryExtraction();
  registerHostMergeStamp();
  registerReviewNotes();
  registerSourcePushReactions();
  registerLiveReadingInvalidation();
  registerErrorSightings();
}
