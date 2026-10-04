// The execution context's ports, filled once at boot by the process entry. Each execution kernel
// imports only kernel and platform modules and each execution domain only its own context or one
// before it (ADR 0008), so what they need from above is handed in here, from the owners' faces.

import { readThresholds } from './admin-thresholds/index.js';
import { provideAgentReportsPorts } from './agent-reports/index.js';
import { provideAgentSessionsPorts } from './agent-sessions/index.js';
import {
  insertComment,
  latestIssueCommentWith,
  postIssueNotice,
  postIssueNoticeOnce,
} from './comments/index.js';
import { readContentLanguage } from './content-language/index.js';
import { registerConversationAgentBridge, resolveProjectHandle } from './conversations/index.js';
import { deviceHolderUserId, provideDevicesPorts } from './devices/index.js';
import {
  loadContractContext,
  pathsNamedIn,
  recordContractContext,
  renderContractContext,
} from './ecosystem/index.js';
import { reportLinksOf } from './feedback/index.js';
import { isHttpsGitUrl, projectsWithHostCredential } from './git/index.js';
import { getPublishedRunnerBuild } from './install/index.js';
import { applyGrantedMcpServers, decryptSecret, isVaultConfigured } from './integrations/index.js';
import { callFastModel } from './integrations/llm/index.js';
import { cmpVersion, mainRunnerHead } from './integrations/published-releases/index.js';
import { readPullRequestsForIssues } from './integrations/source-host/index.js';
import {
  countInFlightByRunner,
  insertInterventionEvent,
  provideJobsPorts,
  resolveSessionMcpServers,
} from './jobs/index.js';
import { foreignScriptChars } from './memory/index.js';
import { emitNotification } from './notifications/index.js';
import {
  dispatchStateOf,
  policyRefusal,
  policyRefusalOf,
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
  waiterFor,
} from './questions/index.js';
import { createReleaseBatch, loadReleaseRoster } from './release-batch/index.js';
import { provideRunnersPorts } from './runners/index.js';
import {
  provideSchedulesPorts,
  redispatchScheduleSessionOnFailover,
  settleSessionFires,
} from './schedules/index.js';
import { recordSkillActivityEvent, resolveRegisteredEffectiveSkills } from './skills/index.js';
import { getStorage } from './storage/index.js';
import {
  issueMockupsOf,
  loadArtifactContext,
  loadPinnedContracts,
  loadRequirementContext,
  recordArtifactContext,
  renderArtifactContext,
  renderIssueMockups,
  renderPinnedContracts,
} from './workflows/index.js';

const skillActivity = { recordSkillActivityEvent };

export function provideExecutionPorts(): void {
  provideJobsPorts({
    buildPipelinePreamble: (projectId, opts) => buildPipelinePreambleStructured(projectId, opts),
    skillActivity,
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
    callFastModel: (scope, prompt, maxTokens) => callFastModel(scope, prompt, maxTokens),
    foreignScriptChars,
    readContentLanguage,
    resolveRegisteredEffectiveSkills,
    settleSessionFires,
    redispatchScheduleSessionOnFailover,
    deviceHolderUserId,
    insertInterventionEvent,
    resolveSessionMcpServers,
    postSteerComment: async ({ issueId, authorId, body }) =>
      (await insertComment({ issueId, authorId, authorDeviceId: null, body, parentId: null })).row,
  });

  provideDevicesPorts({
    readEffectivePolicy,
    policyRefusal,
    policyRefusalOf,
    requirePolicy,
    readPullRequestsForIssues,
    readDeclaredSource,
    remoteOf,
    withDeclaredSource,
    projectsWithHostCredential,
    isHttpsGitUrl,
    publishedRunnerBuild: getPublishedRunnerBuild,
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

  provideRunnersPorts({ readThresholds, countInFlightByRunner });

  provideSchedulesPorts({
    emitNotification,
    loadReleaseRoster,
    createReleaseBatch,
  });

  provideAgentReportsPorts({ reportLinksOf });

  registerConversationAgentBridge();
}
