import { registerReviewNotes } from './comments/index.js';
import { registerSourcePushReactions } from './ecosystem/index.js';
import { registerIntakeAssistant } from './intake/index.js';
import {
  registerActivitySubscribers,
  registerDependencyHealth,
  registerHostMergeStamp,
  registerIssueMoveReactions,
} from './issues/index.js';
import { registerLessonCorrections } from './lessons/index.js';
import {
  registerMemoryExtraction,
  registerMemoryIndexer,
  registerMemoryReconcileTrigger,
} from './memory/index.js';
import {
  registerEcosystemNotifications,
  registerFeedbackNotifications,
  registerNotifyMentionsSubscriber,
  registerRequirementNotifications,
  registerTransitionNotifications,
} from './notifications/index.js';
import { registerFirstRequirementsCase } from './onboarding/index.js';
import {
  registerAnswerResume,
  registerPausedRunWedgeResolve,
  registerPhaseJournalClose,
} from './pipeline/index.js';
import { registerLiveReadingInvalidation } from './projects/index.js';
import { registerQuestionSuggest } from './questions/index.js';
import {
  registerChangeRequestSettle,
  registerReleaseApprovalWake,
  registerReleaseBatchClaimSubscriber,
} from './release-batch/index.js';
import { registerReleaseHighlightsRefresh, registerReleaseNaming } from './release-page/index.js';
import { registerReasonAnswers } from './requirements/index.js';
import { registerSteward } from './steward/index.js';
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
  registerReleaseBatchClaimSubscriber();
  registerReleaseApprovalWake();
  registerChangeRequestSettle();
  registerReleaseHighlightsRefresh();
  registerReleaseNaming();
  registerMemoryIndexer();
  registerMemoryReconcileTrigger();
  registerMemoryExtraction();
  registerHostMergeStamp();
  registerIssueMoveReactions();
  registerDependencyHealth();
  registerReviewNotes();
  registerSourcePushReactions();
  registerLiveReadingInvalidation();
  registerRequirementNotifications();
  registerFirstRequirementsCase();
  registerReasonAnswers();
  registerQuestionSuggest();
  registerFeedbackNotifications();
  registerIntakeAssistant();
  registerSteward();
  registerLessonCorrections();
}
