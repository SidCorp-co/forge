// The execution context's ports, filled once at boot by the process entry. Each execution kernel
// imports only kernel and platform modules and each execution domain only its own context or one
// before it (ADR 0008), so what they need from above is handed in here, from the owners' faces.

import { provideAgentReportsPorts } from './agent-reports/index.js';
import { provideAgentSessionsPorts } from './agent-sessions/index.js';
import {
  insertComment,
  latestIssueCommentWith,
  postIssueNotice,
  postIssueNoticeOnce,
} from './comments/index.js';
import { registerConversationAgentBridge, resolveProjectHandle } from './conversations/index.js';
import {
  deviceHolderUserId,
  provideDevicesPorts,
  readRunnerPoolRead,
  residentMasterSql,
} from './devices/index.js';
import {
  loadContractContext,
  openRunsOf,
  pathsNamedIn,
  recordContractContext,
  renderContractContext,
  unansweredDocuments,
} from './ecosystem/index.js';
import { owedTriages, reportLinksOf } from './feedback/index.js';
import { cmpVersion, mainRunnerHead } from './integrations/github/index.js';
import {
  applyGrantedMcpServers,
  decryptSecret,
  getStorage,
  isVaultConfigured,
} from './integrations/index.js';
import { callFastModel } from './integrations/llm/index.js';
import {
  isHttpsGitUrl,
  projectsWithHostCredential,
  readPullRequestsForIssues,
} from './integrations/source-host/index.js';
import {
  countInFlightByRunner,
  insertInterventionEvent,
  jobsOfSession,
  provideJobsPorts,
  resolveSessionMcpServers,
  scrubJobOutput,
} from './jobs/index.js';
import { provideMastersPorts } from './masters/index.js';
import { foreignScriptChars } from './memory/index.js';
import { emitNotification } from './notifications/index.js';
import {
  dispatchStateOf,
  policyGapOf,
  policyRefusal,
  policyRefusalOf,
  readContentLanguage,
  readDeclaredSource,
  readEffectivePolicy,
  remoteOf,
  requirePolicy,
  withDeclaredSource,
} from './project-config/index.js';
import {
  buildChatPreamble,
  buildPipelinePreambleStructured,
  TOOL_REFERENCE,
} from './prompt/index.js';
import {
  type AskInput,
  answerOf,
  askQuestion,
  registerWaiter,
  voidCancelledRunQuestions,
  waiterFor,
} from './questions/index.js';
import {
  abortBlockedIssues,
  createReleaseBatch,
  loadReleaseRoster,
} from './release-batch/index.js';
import { owedBreakdowns, owedRequirementRevisions } from './requirements/index.js';
import { provideRunnersPorts } from './runners/index.js';
import {
  provideSchedulesPorts,
  redispatchScheduleSessionOnFailover,
  settleSessionFires,
} from './schedules/index.js';
import { recordSkillActivityEvent, resolveRegisteredEffectiveSkills } from './skills/index.js';
import {
  issueMockupsOf,
  loadArtifactContext,
  loadPinnedContracts,
  loadRequirementContext,
  owedDesignRevisions,
  recordArtifactContext,
  renderArtifactContext,
  renderIssueMockups,
  renderPinnedContracts,
} from './workflows/index.js';
import { boxIsListening, sendToBoxNow } from './ws/index.js';

export function provideExecutionPorts(): void {
  provideJobsPorts({
    buildPipelinePreamble: buildPipelinePreambleStructured,
    skillActivity: { recordSkillActivityEvent },
    dispatchPolicy: {
      dispatchState: async (projectId, wanted) =>
        dispatchStateOf(projectId, await requirePolicy(projectId), wanted),
    },
    jobContext: {
      loadArtifactContext,
      renderArtifactContext,
      loadRequirementContext,
      issueMockupsOf,
      renderIssueMockups,
      loadPinnedContracts,
      renderPinnedContracts,
      pathsNamedIn,
      loadContractContext,
      renderContractContext,
      recordArtifactContext,
      recordContractContext,
    },
    vault: { isVaultConfigured, decryptSecret },
    mcpServers: { applyGrantedMcpServers },
    redispatchScheduleSessionOnFailover,
  });

  provideAgentSessionsPorts({
    buildChatPreamble,
    toolReference: () => TOOL_REFERENCE,
    attachments: () => getStorage(),
    callFastModel,
    foreignScriptChars,
    readContentLanguage,
    resolveRegisteredEffectiveSkills,
    settleSessionFires,
    voidCancelledRunQuestions,
    redispatchScheduleSessionOnFailover,
    deviceHolderUserId,
    insertInterventionEvent,
    resolveSessionMcpServers,
    boxIsListening,
    sendToBoxNow,
    scrubSessionOutput: async (sessionId, data) =>
      scrubJobOutput(await jobsOfSession(sessionId), data),
    postSteerComment: async ({ issueId, authorId, body }) =>
      (await insertComment({ issueId, authorId, authorDeviceId: null, body, parentId: null })).row,
  });

  provideDevicesPorts({
    readEffectivePolicy,
    policyRefusal,
    policyRefusalOf,
    policyGapOf: (projectId, held, status) =>
      policyGapOf(projectId, held as Parameters<typeof policyGapOf>[1], status),
    requirePolicy,
    readPullRequestsForIssues,
    readDeclaredSource,
    remoteOf,
    withDeclaredSource,
    projectsWithHostCredential,
    isHttpsGitUrl,
    mainRunnerHead,
    cmpVersion,
    questions: {
      askQuestion: (input) => askQuestion(input as AskInput),
      registerWaiter,
      waiterFor,
      answerOf,
    },
    comments: { postIssueNotice, postIssueNoticeOnce, latestIssueCommentWith },
    projectHandleUserId: async (tx, projectId) =>
      (await resolveProjectHandle(tx, projectId)).userId,
  });

  provideRunnersPorts({
    countInFlightByRunner,
    residentMasterSql,
    readRunnerPoolRead,
    boxIsListening,
    sendToBoxNow,
  });

  provideSchedulesPorts({
    emitNotification,
    loadReleaseRoster,
    abortBlockedIssues,
    createReleaseBatch,
  });

  provideAgentReportsPorts({ reportLinksOf });

  provideMastersPorts({
    channelOwed: async (projectId) => ({
      documents: await unansweredDocuments(projectId),
      builderRuns: await openRunsOf(projectId),
    }),
    breakdownsOwed: owedBreakdowns,
    revisionsOwed: owedRequirementRevisions,
    triagesOwed: (projectId) => owedTriages(projectId),
    designsOwed: owedDesignRevisions,
  });

  registerConversationAgentBridge();
}
