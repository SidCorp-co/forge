// The execution context's ports, filled once at boot by the process entry. Each execution kernel
// imports only kernel and platform modules and each execution domain only its own context or one
// before it (ADR 0008), so what they need from above is handed in here, from the owners' faces.

import { provideAgentSessionsPorts } from './agent-sessions/index.js';
import { latestIssueCommentWith, postIssueNotice, postIssueNoticeOnce } from './comments/index.js';
import { registerConversationAgentBridge, resolveProjectHandle } from './conversations/index.js';
import {
  declaredRunOfCall,
  deviceHolderUserId,
  provideDevicesPorts,
  readRunnerPoolRead,
  residentMasterSql,
} from './devices/index.js';
import {
  contractProviderGate,
  loadContractContext,
  openRunsOf,
  pathsNamedIn,
  recordContractContext,
  renderContractContext,
  unansweredDocuments,
} from './ecosystem/index.js';
import { owedAgentConfirms, owedTriages } from './feedback/index.js';
import { cmpVersion, mainRunnerHead } from './integrations/github/index.js';
import {
  applyGrantedMcpServers,
  decryptSecret,
  getStorage,
  isVaultConfigured,
} from './integrations/index.js';
import { callFastModel } from './integrations/llm/index.js';
import {
  gitRemoteThroughForge,
  isHttpsGitUrl,
  projectsWithHostCredential,
  readPullRequestsForIssues,
} from './integrations/source-host/index.js';
import {
  draftIssuesPeopleFiled,
  recordRunSecretResolve,
  runSecretRefsOfSession,
} from './issues/index.js';
import {
  countInFlightByRunner,
  insertInterventionEvent,
  jobsOfSession,
  provideJobsPorts,
  resolveSessionMcpServers,
  scrubSessionSecrets,
} from './jobs/index.js';
import { formatIssueRef } from './lib/issue-ref.js';
import { provideMastersPorts } from './masters/index.js';
import { foreignScriptChars } from './memory/index.js';
import { emitNotification } from './notifications/index.js';
import { landedWorkOwed } from './pipeline/index.js';
import { registerRoomBridge } from './previews/index.js';
import {
  dispatchStateOf,
  gateOf,
  parseRepository,
  policyGapOf,
  policyRefusal,
  policyRefusalOf,
  readContentLanguage,
  readDeclaredSource,
  readEffectivePolicy,
  readGateModes,
  remoteOf,
  requirePolicy,
  withDeclaredSource,
} from './project-config/index.js';
import {
  buildChatPreamble,
  buildPipelinePreambleStructured,
  servedCheckoutOrientation,
  TOOL_REFERENCE,
} from './prompt/index.js';
import {
  type AskInput,
  answeredOnIssuesSince,
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
  owedReleaseNotes,
  provideReleaseBatchPorts,
  releaseApprovalsOwed,
  releaseMergesOwed,
  unnamedReleases,
  warnedReleaseNotes,
} from './release-batch/index.js';
import {
  owedBreakdowns,
  owedRequirementRevisions,
  proposedDraftRequirements,
} from './requirements/index.js';
import { provideRunnersPorts } from './runners/index.js';
import {
  provideSchedulesPorts,
  redispatchScheduleSessionOnFailover,
  settleSessionFires,
} from './schedules/index.js';
import { recordSkillActivityEvent, resolveRegisteredEffectiveSkills } from './skills/index.js';
import { sendStatusReport } from './status-reports/index.js';
import {
  breakdownsHeldBySteward,
  openStewardAsks,
  releaseNamerOf,
  stewardJobCredential,
} from './steward/index.js';
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
import { boxIsListening, sendToBoxNow, wakeMastersForProject } from './ws/index.js';

/** Forge's git relay URL for a repository whose binding reaches git only through it (REQ-73 BC-5), else null. */
async function relayRemoteOf(projectId: string, repository: string): Promise<string | null> {
  const ref = parseRepository(repository);
  return ref.kind === 'hosted'
    ? gitRemoteThroughForge(projectId, { host: ref.host, path: ref.path })
    : null;
}

/** A checkout's remote: Forge's git relay where the project's binding is relayed, else the host's own URL. */
async function checkoutRemoteOf(projectId: string, repository: string): Promise<string> {
  return (await relayRemoteOf(projectId, repository)) ?? remoteOf(repository);
}

/** What the testing-secrets door reads and writes for a run a master declared, where no job holds it. */
export const declaredRunSecretPorts = { declaredRunOfCall, recordRunSecretResolve };

export function provideExecutionPorts(): void {
  provideReleaseBatchPorts({
    contractProviderGate,
    // a release at its gate wakes the master the way an issue arriving there does
    wakeMasters: (projectId) =>
      wakeMastersForProject({ projectId, issueId: null, status: 'awaiting_release' }),
  });
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
    stewardJobCredential,
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
      scrubSessionSecrets(
        {
          id: sessionId,
          jobIds: await jobsOfSession(sessionId),
          read: await runSecretRefsOfSession(sessionId),
        },
        data,
      ),
  });

  provideDevicesPorts({
    readEffectivePolicy,
    readGateModes,
    policyRefusal,
    policyRefusalOf,
    policyGapOf: (projectId, held, status) =>
      policyGapOf(projectId, held as Parameters<typeof policyGapOf>[1], status),
    requirePolicy,
    readPullRequestsForIssues,
    readDeclaredSource,
    checkoutRemoteOf,
    relayRemoteOf,
    withDeclaredSource,
    projectsWithHostCredential,
    isHttpsGitUrl,
    mainRunnerHead,
    cmpVersion,
    checkoutOrientation: servedCheckoutOrientation,
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
    sendStatusReport,
  });

  provideMastersPorts({
    channelOwed: async (projectId) => ({
      documents: await unansweredDocuments(projectId),
      builderRuns: await openRunsOf(projectId),
    }),
    breakdownsOwed: owedBreakdowns,
    revisionsOwed: owedRequirementRevisions,
    triagesOwed: (projectId) => owedTriages(projectId),
    confirmsOwed: owedAgentConfirms,
    designsOwed: owedDesignRevisions,
    releaseNotesOwed: owedReleaseNotes,
    releaseNotesWarned: warnedReleaseNotes,
    releasesUnnamed: unnamedReleases,
    releaseNamer: releaseNamerOf,
    releaseMergesOwed,
    releaseApprovalsOwed,
    answersSince: async (projectId, after) =>
      (await answeredOnIssuesSince(projectId, after)).map((a) => ({
        issueKey: formatIssueRef(a.issuePrefix, a.issSeq),
        questionId: a.questionId,
        outcome: a.resume,
      })),
    contentLanguageOf: async (projectId) => (await readContentLanguage(projectId)).contentLanguage,
    stewardAsks: openStewardAsks,
    breakdownsHeldBySteward,
    landedWorkOwed,
    masterGate: (projectId) => gateOf(projectId, 'master_admitted_only'),
    requestsWaiting: async (projectId) => [
      ...(await draftIssuesPeopleFiled(projectId)).map((r) => ({
        kind: 'issue' as const,
        key: r.key,
      })),
      ...(await proposedDraftRequirements(projectId)).map((r) => ({
        kind: 'requirement' as const,
        key: r.key,
      })),
    ],
  });

  registerConversationAgentBridge();
  registerRoomBridge();
}
