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
  resolveSessionSend,
  stampFinalizeAttempt,
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
import { provideDevelopmentPorts } from './development/index.js';
import { ADMITTED_RUNNER, readRunGate } from './devices/index.js';
import {
  decideChannelGate,
  doorOf,
  landingDriftRefusal,
  landingWorld,
  settlingContractVersion,
  tokenIdOf,
} from './ecosystem/index.js';
import { rowIn as feedbackRowIn, listFeedbackAs } from './feedback/index.js';
import { guideRef } from './guides/index.js';
import { getStorage, isEnoent, readStorefrontDrafts } from './integrations/index.js';
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
import { deleteMemory, runMemorySearch } from './memory/index.js';
import { retryRescuesSince } from './metrics/index.js';
import {
  emitNotification,
  projectAdminUserIds,
  projectAdminUserIdsFor,
  resolveNotifications,
} from './notifications/index.js';
import {
  afterOnboardingSubmit,
  onboardingSubmittedIn,
  provideOnboardingPorts,
} from './onboarding/index.js';
import {
  closeOpenRunForIssue,
  getIssueContexts,
  providePipelinePorts,
  shippedReleasesOf,
  triggerPipelineStepManual,
} from './pipeline/index.js';
import {
  policyGapsOf,
  policyRefusal,
  readEffectivePolicy,
  readLandingBranches,
  readProjectDocument,
} from './project-config/index.js';
import {
  declaredIssueSeqs,
  issueRefPattern,
  liveReachForIssue,
  projectCreatorOf,
  subjectOf,
} from './projects/index.js';
import { provideQuestionnairePorts } from './questionnaires/index.js';
import {
  answerDesignQuestions,
  answeredHoldOf,
  answeredSince,
  answeredSinceSql,
  answerMergeQuestions,
  askParkQuestion,
  holdsOpenHumanQuestion,
  openHumanQuestionIdsOn,
  pendingDesignOfPark,
  personOwesAnAnswer,
  provideQuestionPorts,
  reaskSupersededDesignQuestions,
  recordAnswerResume,
  settleOpenQuestions,
  voidCancelledRunQuestions,
} from './questions/index.js';
import { approvalRequired } from './release-batch/index.js';
import {
  changedTracedOf,
  contractAboutRefusal,
  liveTracedCodesOf,
  planDriftOf,
  plannedRevisionFor,
  requirementIdIn,
  requirementOfIssue,
  rowIn as requirementRowIn,
  requirementStatesOf,
  traceWordingsOf,
} from './requirements/index.js';
import { runnerEventsRetention } from './runners/index.js';
import { latestRunsOfIssues, runWaitingOf } from './runs/index.js';
import { lastFires, readScheduleStreaks, streakFails } from './schedules/index.js';
import { provideUploadPorts } from './uploads/index.js';
import {
  assertDesignApprovedForIssue,
  assertDesignsApprovedForSeqs,
  buildsWorkflowOf,
  decisionNodeRefusal,
  designHoldsOf,
  designUnapprovedSql,
  projectHealthAs,
  proposesWorkflowOf,
  provideWorkflowHealthPorts,
  provideWorkflowPorts,
  repinGroupsAs,
} from './workflows/index.js';
import { wakeMastersForProject } from './ws/index.js';

/** A cited file larger than this reads as unreadable rather than as missing. */
const OBSERVED_FILE_BYTES = 4_000_000;

/** What the pipeline reads from the modules it may not import. */
function provideWorkPipelinePorts(): void {
  providePipelinePorts({
    insertJobRow,
    wakeMastersForProject,
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
    },
    emitNotification,
    resolveNotifications,
    projectAdminUserIds,
    projectCreatorOf,
    projectAdminUserIdsFor,
    existingProjectHandle,
    resolveProjectHandle,
    retryRescuesSince,
    postIssueNotice,
    postIssueNoticeOnce,
    holdsOpenHumanQuestion,
    personOwesAnAnswer,
    voidCancelledRunQuestions,
    answeredHoldOf,
    recordAnswerResume,
    refreshModuleKnowledgeForIssue,
    readEffectivePolicy,
    policyRefusal,
  });
}

export function provideWorkPorts(): void {
  provideWorkPipelinePorts();

  provideIssuePorts({
    projectCreatorOf,
    settleOpenQuestions,
    holdsOpenHumanQuestion,
    personOwesAnAnswer,
    askParkQuestion,
    pendingDesignOfPark,
    answerMergeQuestions,
    openHumanQuestionIdsOn,
    answeredSince,
    answeredSinceSql,
    postIssueNotice,
    messageRefusalHttp,
    readProjectDocument,
    planDriftOf,
    changedTracedOf,
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
    designUnapprovedSql,
    assertDesignsApprovedForSeqs,
    assertDesignApprovedForIssue,
    designHoldsOf,
    buildsWorkflowOf,
    settlingContractVersion,
    proposesWorkflowOf,
    requirementOfIssue,
    traceWordingsOf,
    liveTracedCodesOf,
    shippedReleaseOf: async (projectId, issueId) =>
      (await shippedReleasesOf(projectId, [issueId])).get(issueId) ?? null,
    plannedRevisionFor,
    approvalRequired,
    policyGapsOf,
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
    readStorefrontDrafts,
    handoffContextsOf: (projectId, issueId) =>
      getIssueContexts({ projectId, issueId, kind: 'handoff', limit: 200, orderDir: 'asc' }),
    closeOpenRunForIssue,
    triggerPipelineStepManual,
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
    designNodeRefusal: decisionNodeRefusal,
  });

  provideWorkflowPorts({
    changedTracedOf,
    requirementStatesOf,
    answerDesignQuestions,
    reaskSupersededDesignQuestions,
    repositoryOf: async (projectId) => {
      const { defaultBranch } = await readLandingBranches(projectId);
      if (!defaultBranch) {
        return {
          unreadable:
            'the project document declares no default branch, so there is no landing branch an observed commit can be checked against',
        };
      }
      let host: Awaited<ReturnType<typeof resolveSourceHost>>;
      try {
        host = await resolveSourceHost(projectId, 'kernel');
      } catch (err) {
        if (err instanceof SourceHostUnavailable) return { unreadable: err.message };
        throw err;
      }
      return {
        branch: defaultBranch,
        contains: (sha) => host.branchContains(defaultBranch, sha),
        readFile: (path, sha) => host.readFile(path, sha, OBSERVED_FILE_BYTES),
      };
    },
  });

  provideDevelopmentPorts({ designHealthOf: projectHealthAs, designRepinsOf: repinGroupsAs });

  provideWorkflowHealthPorts({
    openFeedbackOf: async (viewer, projectId) => {
      const read = await listFeedbackAs(viewer, projectId, {
        phases: ['new', 'triaged', 'planned', 'reopened'],
      });
      if (!read.ok) {
        throw new Error(
          `workflow health: the feedback list refused its own phase read (${read.refusals.map((r) => r.code).join(', ')})`,
        );
      }
      return read.list.feedback;
    },
    latestRunsOf: (viewer, projectId, issueIds) =>
      latestRunsOfIssues(projectId, issueIds, { userId: viewer.userId }),
  });

  provideLabelPorts({ listFeedbackAs });

  provideOnboardingPorts({ runWaitingOf });

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
    requirementIdIn,
    contractAboutRefusal,
  });

  provideUploadPorts({ persistConversationAttachment });
}
