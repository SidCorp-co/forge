import { registerCommentMirror } from './integrations/rocketchat/comment-mirror.js';
import { registerMemoryReconcileTrigger } from './memory/consolidation.js';
import { registerMemoryExtraction } from './memory/extraction.js';
import { registerMemoryIndexer } from './memory/indexer.js';
import { registerNotifyMentionsSubscriber } from './notifications/notify-mentions.js';
import { registerTransitionNotifications } from './notifications/notify-transitions.js';
import { registerAnswerResume } from './pipeline/answer-resume.js';
import { registerPipelineOrchestrator } from './pipeline/orchestrator.js';
import { registerPausedRunWedgeResolve } from './pipeline/paused-run-wedge-resolve.js';
import { registerPhaseJournalClose } from './pipeline/phase-journal-close.js';
import { registerActivitySubscribers } from './pipeline/subscribers.js';
import { registerPmSubscribers } from './pm/subscribers.js';
import { registerReleaseBatchClaimSubscriber } from './release-batch/claim-subscriber.js';
import { registerWebhookSubscribers } from './webhooks/subscribers.js';
import { registerWsBroadcastSubscribers } from './ws/broadcast-subscribers.js';
import { registerMasterWakeSubscribers } from './ws/master-wake.js';

/**
 * Every consumer of the outbox, registered once before the worker starts. Order is delivery order
 * within one event: the push and the feed first, so a slow consumer behind them delays neither.
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
  registerCommentMirror();
  registerMemoryIndexer();
  registerMemoryReconcileTrigger();
  registerMemoryExtraction();
}
