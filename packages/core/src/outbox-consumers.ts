import { registerReviewNotes } from './comments/index.js';
import { registerSourcePushReactions } from './ecosystem/index.js';
import {
  registerActivitySubscribers,
  registerHostMergeStamp,
  registerIssueMoveReactions,
} from './issues/index.js';
import {
  registerMemoryExtraction,
  registerMemoryIndexer,
  registerMemoryReconcileTrigger,
} from './memory/index.js';
import {
  registerEcosystemNotifications,
  registerNotifyMentionsSubscriber,
  registerTransitionNotifications,
} from './notifications/index.js';
import {
  registerAnswerResume,
  registerPausedRunWedgeResolve,
  registerPhaseJournalClose,
  registerRunStatusBroadcast,
} from './pipeline/index.js';
import { registerLiveReadingInvalidation } from './projects/index.js';
import { registerReleaseBatchClaimSubscriber } from './release-batch/index.js';
import { registerMasterWakeSubscribers, registerWsBroadcastSubscribers } from './ws/index.js';

/**
 * Every consumer of the outbox, registered once before the worker starts, each under a name
 * `@forge/contracts/outbox-consumers:OUTBOX_CONSUMERS` declares. Each consumer has its own delivery
 * row per event, so the order here decides nothing.
 */
export function registerOutboxConsumers(): void {
  registerWsBroadcastSubscribers();
  registerActivitySubscribers();
  registerAnswerResume();
  registerMasterWakeSubscribers();
  registerTransitionNotifications();
  registerNotifyMentionsSubscriber();
  registerEcosystemNotifications();
  registerPhaseJournalClose();
  registerPausedRunWedgeResolve();
  registerRunStatusBroadcast();
  registerReleaseBatchClaimSubscriber();
  registerMemoryIndexer();
  registerMemoryReconcileTrigger();
  registerMemoryExtraction();
  registerHostMergeStamp();
  registerIssueMoveReactions();
  registerReviewNotes();
  registerSourcePushReactions();
  registerLiveReadingInvalidation();
}
