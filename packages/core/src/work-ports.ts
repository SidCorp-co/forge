// The composition root's half of every port the work context declares: the modules work may not
// import, handed to it at boot so work stays upstream of execution and of the contexts below it.

import { fireOfCaller, issueDeleteRefusal } from './agent-reports/index.js';
import {
  agentSessionEventsRetention,
  deriveSessionFinal,
  requestSessionSend,
  resolveSessionSend,
  stampFinalizeAttempt,
  steerIssue,
  transitionSessions,
} from './agent-sessions/index.js';
import { messageRefusalHttp, postIssueNotice, postIssueNoticeOnce } from './comments/index.js';
import { existingProjectHandle, resolveProjectHandle } from './conversations/index.js';
import { ADMITTED_RUNNER, readRunGate } from './devices/index.js';
import {
  assertWaitsSettledForIssue,
  assertWaitsSettledForSeqs,
  ContractWaitUnsettledError,
  landingDriftRefusal,
  landingWorld,
  waitsOnContractsOf,
  waitUnsettledSql,
} from './ecosystem/index.js';
import { guideRef } from './guides/index.js';
import { embedBatch } from './integrations/embeddings/index.js';
import { readStorefrontDraft } from './integrations/index.js';
import { resolveSourceHost, SourceHostUnavailable } from './integrations/source-host/index.js';
import { provideIssuePorts } from './issues/index.js';
import {
  broadcastSessionEvent,
  extractStageStatus,
  freshRunnerAvailability,
  gateReasonsForQueuedJobsIn,
  getLoopThresholds,
  HOLD_PAYLOAD_KEY,
  holdReleasesItself,
  insertJobRow,
  jobEventsRetention,
  killGraceMs,
  noPromptMessage,
  parkedOnAHuman,
  RETRY_MAX_ROUNDS,
  readAutoRetryPayload,
  readHoldState,
  requestJobKill,
} from './jobs/index.js';
import { refreshModuleKnowledgeForIssue } from './labels/index.js';
import { deleteMemory, retrievalAnalyticsRetention, runMemorySearch } from './memory/index.js';
import { buildInterventionsReport, retryRescuesSince } from './metrics/index.js';
import {
  createNotification,
  emitNotification,
  projectAdminUserIds,
  projectAdminUserIdsFor,
  resolveNotifications,
} from './notifications/index.js';
import { providePipelinePorts } from './pipeline/index.js';
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
  setProjectIssuePrefix,
  subjectOf,
} from './projects/index.js';
import {
  askParkQuestion,
  holdsOpenHumanQuestion,
  openHumanQuestionIdsOn,
  personOwesAnAnswer,
  settleOpenQuestions,
} from './questions/index.js';
import { approvalRequired } from './release-batch/index.js';
import { plannedRevisionFor, requirementOfIssue } from './requirements/index.js';
import { runnerEventsRetention } from './runners/index.js';
import { failReconcileRunForFailedJob } from './skills/index.js';
import { getStorage, isEnoent } from './storage/index.js';
import {
  EMPTY_USAGE_TOTALS,
  usageSessionMatch,
  usageTotalsSelection,
} from './usage-records/index.js';
import {
  assertDesignApprovedForIssue,
  assertDesignsApprovedForSeqs,
  buildsWorkflowOf,
  designUnapprovedSql,
  proposesWorkflowOf,
  WorkflowDesignNotApprovedError,
} from './workflows/index.js';
import { wakeMastersForProject } from './ws/index.js';

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
    failReconcileRunForFailedJob,
    holdPayloadKey: HOLD_PAYLOAD_KEY,
    readHoldState,
    holdReleasesItself,
    gateReasonsForQueuedJobsIn,
    retryMaxRounds: RETRY_MAX_ROUNDS,
    readAutoRetryPayload,
    readRunGate,
    admittedRunner: ADMITTED_RUNNER,
    usageSessionMatch,
    deriveSessionFinal,
    stampFinalizeAttempt,
    retentionStatements: {
      job_events: jobEventsRetention,
      agent_session_events: agentSessionEventsRetention,
      runner_events: runnerEventsRetention,
      retrieval_analytics: retrievalAnalyticsRetention,
    },
    emitNotification,
    createNotification,
    resolveNotifications,
    projectAdminUserIds,
    projectAdminUserIdsFor,
    existingProjectHandle,
    resolveProjectHandle,
    retryRescuesSince,
    buildInterventionsReport,
    postIssueNotice,
    postIssueNoticeOnce,
    holdsOpenHumanQuestion,
    personOwesAnAnswer,
    refreshModuleKnowledgeForIssue,
    readEffectivePolicy,
    policyRefusal,
    readLandingBranches,
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
    readLandingBranches,
    setProjectIssuePrefix,
    issueRefPattern,
    declaredIssueSeqs,
    subjectOf,
    liveReachForIssue,
    getLoopThresholds,
    noPromptMessage,
    extractStageStatus,
    readHoldState,
    holdReleasesItself,
    freshRunnerAvailability,
    usageSessionMatch,
    usageTotalsSelection,
    emptyUsageTotals: EMPTY_USAGE_TOTALS,
    fireOfCaller,
    issueDeleteRefusal,
    steerIssue,
    designUnapprovedSql,
    waitUnsettledSql,
    assertDesignsApprovedForSeqs,
    assertWaitsSettledForSeqs,
    assertDesignApprovedForIssue,
    assertWaitsSettledForIssue,
    isDispatchGateError: (
      err,
    ): err is WorkflowDesignNotApprovedError | ContractWaitUnsettledError =>
      err instanceof WorkflowDesignNotApprovedError || err instanceof ContractWaitUnsettledError,
    buildsWorkflowOf,
    waitsOnContractsOf,
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
  });
}
