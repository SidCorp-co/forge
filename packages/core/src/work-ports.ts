// The composition root's half of every port the work context declares: the modules work may not
// import, handed to it at boot so work stays upstream of execution and of the contexts below it.

import {
  fireOfCaller,
  issueDeleteRefusal,
  reportViewById,
  reportViewsIn,
} from './agent-reports/index.js';
import {
  agentSessionEventsRetention,
  deriveSessionFinal,
  EMPTY_USAGE_TOTALS,
  requestSessionSend,
  resolveSessionSend,
  stampFinalizeAttempt,
  steerIssue,
  transitionSessions,
  usageSessionMatch,
  usageTotalsByRun,
  usageTotalsForRun,
  usageTotalsSelection,
} from './agent-sessions/index.js';
import { publishToConversationReaders, WEB_CONVERSATION_EVENT } from './assistant/index.js';
import { provideAutomationPorts } from './automation/index.js';
import {
  messageRefusalHttp,
  postIssueNotice,
  postIssueNoticeOnce,
  provideCommentPorts,
} from './comments/index.js';
import {
  appendMessagesIn,
  CONVERSATION_AGENT_MARKER,
  existingProjectHandle,
  handleForProject,
  openOrExtendWindow,
  persistConversationAttachment,
  readConversationAgentMeta,
  resolveProjectHandle,
} from './conversations/index.js';
import { ADMITTED_RUNNER, readRunGate } from './devices/index.js';
import {
  decideChannelGate,
  doorOf,
  landingDriftRefusal,
  landingWorld,
  tokenIdOf,
} from './ecosystem/index.js';
import { rowIn as feedbackRowIn, listFeedbackAs } from './feedback/index.js';
import { guideRef } from './guides/index.js';
import { getStorage, isEnoent, readStorefrontDraft } from './integrations/index.js';
import { embedBatch } from './integrations/llm/index.js';
import { resolveSourceHost, SourceHostUnavailable } from './integrations/source-host/index.js';
import { provideIssuePorts } from './issues/index.js';
import {
  broadcastSessionEvent,
  extractStageStatus,
  freshRunnerAvailability,
  gateReasonsForQueuedJobsIn,
  getLoopThresholds,
  insertJobRow,
  jobEventsRetention,
  killGraceMs,
  parkedOnAHuman,
  requestJobKill,
} from './jobs/index.js';
import { provideLabelPorts, refreshModuleKnowledgeForIssue } from './labels/index.js';
import { deleteMemory, retrievalAnalyticsRetention, runMemorySearch } from './memory/index.js';
import { retryRescuesSince } from './metrics/index.js';
import {
  emitNotification,
  projectAdminUserIds,
  projectAdminUserIdsFor,
  resolveNotifications,
} from './notifications/index.js';
import { afterOnboardingSubmit, onboardingSubmittedIn } from './onboarding/index.js';
import { closeOpenRunForIssue, getIssueContexts, providePipelinePorts } from './pipeline/index.js';
import {
  policyRefusal,
  readEffectivePolicy,
  readLandingBranches,
  readProjectDocument,
} from './project-config/index.js';
import {
  declaredIssueSeqs,
  issueRefPattern,
  liveReachForIssue,
  subjectOf,
} from './projects/index.js';
import { provideQuestionnairePorts } from './questionnaires/index.js';
import {
  askParkQuestion,
  holdsOpenHumanQuestion,
  openHumanQuestionIdsOn,
  personOwesAnAnswer,
  provideQuestionPorts,
  settleOpenQuestions,
} from './questions/index.js';
import { approvalRequired } from './release-batch/index.js';
import {
  planDriftOf,
  plannedRevisionFor,
  requirementOfIssue,
  rowIn as requirementRowIn,
} from './requirements/index.js';
import { runnerEventsRetention } from './runners/index.js';
import { lastFires, readScheduleStreaks, streakFails } from './schedules/index.js';
import { provideUploadPorts } from './uploads/index.js';
import {
  assertDesignApprovedForIssue,
  assertDesignsApprovedForSeqs,
  buildsWorkflowOf,
  designNodesIn,
  designUnapprovedSql,
  nodeRefRefusal,
  proposesWorkflowOf,
  WorkflowDesignNotApprovedError,
} from './workflows/index.js';
import { wakeMastersForAnswer, wakeMastersForProject } from './ws/index.js';

export function provideWorkPorts(): void {
  providePipelinePorts({
    insertJobRow,
    wakeMastersForProject,
    requestSessionSend,
    resolveSessionSend,
    transitionSessions,
    broadcastSessionEvent,
    getLoopThresholds,
    killGraceMs,
    parkedOnAHuman,
    requestJobKill,
    gateReasonsForQueuedJobsIn,
    readRunGate,
    admittedRunner: ADMITTED_RUNNER,
    usageTotalsByRun,
    usageTotalsForRun,
    deriveSessionFinal,
    stampFinalizeAttempt,
    retentionStatements: {
      job_events: jobEventsRetention,
      agent_session_events: agentSessionEventsRetention,
      runner_events: runnerEventsRetention,
      retrieval_analytics: retrievalAnalyticsRetention,
    },
    emitNotification,
    resolveNotifications,
    projectAdminUserIds,
    projectAdminUserIdsFor,
    existingProjectHandle,
    resolveProjectHandle,
    retryRescuesSince,
    postIssueNotice,
    postIssueNoticeOnce,
    holdsOpenHumanQuestion,
    personOwesAnAnswer,
    refreshModuleKnowledgeForIssue,
    readEffectivePolicy,
    policyRefusal,
  });

  provideIssuePorts({
    settleOpenQuestions,
    holdsOpenHumanQuestion,
    personOwesAnAnswer,
    askParkQuestion,
    openHumanQuestionIdsOn,
    postIssueNotice,
    messageRefusalHttp,
    readProjectDocument,
    planDriftOf,
    readLandingBranches,
    issueRefPattern,
    declaredIssueSeqs,
    subjectOf,
    liveReachForIssue,
    getLoopThresholds,
    extractStageStatus,
    freshRunnerAvailability,
    usageSessionMatch,
    usageTotalsSelection,
    emptyUsageTotals: EMPTY_USAGE_TOTALS,
    fireOfCaller,
    issueDeleteRefusal,
    steerIssue,
    designUnapprovedSql,
    assertDesignsApprovedForSeqs,
    assertDesignApprovedForIssue,
    isDispatchGateError: (err): err is WorkflowDesignNotApprovedError =>
      err instanceof WorkflowDesignNotApprovedError,
    buildsWorkflowOf,
    proposesWorkflowOf,
    requirementOfIssue,
    plannedRevisionFor,
    approvalRequired,
    contractDrift: async (issue, landed) =>
      landingDriftRefusal(landed, await landingWorld(issue, landed)),
    guideRef,
    deleteMemory,
    runMemorySearch,
    embedBatch,
    getStorage,
    isEnoent,
    resolveSourceHost,
    isSourceHostUnavailable: (err): err is SourceHostUnavailable =>
      err instanceof SourceHostUnavailable,
    readStorefrontDraft,
    handoffContextsOf: (projectId, issueId) =>
      getIssueContexts({ projectId, issueId, kind: 'handoff', limit: 200, orderDir: 'asc' }),
    closeOpenRunForIssue,
  });

  provideAutomationPorts({
    reportRows: reportViewsIn,
    reportRow: reportViewById,
    lastFires,
    readScheduleStreaks,
    streakFails,
  });

  provideCommentPorts({
    requirementRowIn,
    feedbackRowIn,
    designNodeRefusal: async (tx, projectId, workflowRef, node, base) => {
      const nodes = await designNodesIn(tx, projectId, workflowRef);
      return nodes ? nodeRefRefusal(nodes, node, base) : null;
    },
  });

  provideLabelPorts({ listFeedbackAs: (viewer, projectId) => listFeedbackAs(viewer, projectId) });

  provideQuestionnairePorts({
    appendMessagesIn,
    handleForProject,
    openOrExtendWindow,
    announceConversationChange: (conversationId, data) =>
      publishToConversationReaders(conversationId, { event: WEB_CONVERSATION_EVENT, data }),
    onSubmittedIn: onboardingSubmittedIn,
    afterSubmit: afterOnboardingSubmit,
  });

  provideQuestionPorts({
    decideChannelGate,
    doorOfRequest: (c) => doorOf(tokenIdOf(c)),
    conversationTurnOf: (metadata) => {
      const marked = (metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
      return marked === undefined || marked === null
        ? null
        : { meta: readConversationAgentMeta(metadata) };
    },
    wakeMastersForAnswer,
  });

  provideUploadPorts({ persistConversationAttachment });
}
