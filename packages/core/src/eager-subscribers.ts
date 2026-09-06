// The subscribers registered at import time, in the order they were written.
//
// They were fourteen calls and their imports inside `index.ts`, which sits over the
// 500-line file budget — so every new subscriber grew the composition root until the
// budget refused the next one. Moved verbatim: the ORDER is part of the behaviour for
// anything reacting to the same topic.

import { registerFeedbackNormalizer } from './feedback/normalizer.js';
import { registerCandidatesObserver } from './memory/candidates-observer.js';
import { registerMemoryReconcileTrigger } from './memory/consolidation.js';
import { registerMemoryExtraction } from './memory/extraction.js';
import { registerMemoryIndexer } from './memory/indexer.js';
import { registerNotifyMentionsSubscriber } from './notifications/notify-mentions.js';
import { registerTransitionNotifications } from './notifications/notify-transitions.js';
import { registerCiFixPatternLearner } from './pipeline/ci-fix-pattern-learn.js';
import type { HooksBus } from './pipeline/hooks.js';
import { registerPipelineSentryBreadcrumbs } from './pipeline/sentry-breadcrumbs.js';
import { registerActivitySubscribers } from './pipeline/subscribers.js';
import { registerPmSubscribers } from './pm/subscribers.js';
import { registerReleaseBatchClaimSubscriber } from './release-batch/claim-subscriber.js';
import { registerWsBroadcastSubscribers } from './ws/broadcast-subscribers.js';
import { registerMasterWakeSubscribers } from './ws/master-wake.js';

// cm:guard registration order is the order below, unchanged from index.ts. HooksBus runs subscribers in registration order, so reordering these silently reorders side effects on a shared topic.
export function registerEagerSubscribers(bus: HooksBus): void {
  registerActivitySubscribers(bus);
  registerPipelineSentryBreadcrumbs(bus);
  registerWsBroadcastSubscribers(bus);
  registerMemoryIndexer(bus);
  registerMemoryReconcileTrigger(bus);
  registerCiFixPatternLearner(bus);
  registerMemoryExtraction(bus);
  registerNotifyMentionsSubscriber(bus);
  registerTransitionNotifications(bus);
  registerPmSubscribers(bus);
  registerCandidatesObserver(bus);
  registerFeedbackNormalizer(bus);
  registerReleaseBatchClaimSubscriber(bus);
  registerMasterWakeSubscribers(bus);
}
