// What the issue kernel needs from modules it may not import: the domains of its own context
// (questions, comments), the project document and the projects domain, execution (jobs, sessions,
// usage, agent reports), the design and release domains, knowledge, and the adapters (storage,
// embeddings, the source host, a storefront). A kernel imports only kernels and the platform, so
// each need is declared here and the composition root fills it at boot (`provideProjectOrg` is the
// pattern).

import type { verdictsRequiredOf } from '@forge/contracts/delivery-policy';
import type { OutboxActor } from '@forge/contracts/outbox-events';
import type { PolicyRefusalCode } from '@forge/contracts/project-config';
import type { AnswerHold, AnswerResume } from '@forge/contracts/questions';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import type { EgressScope } from '../lib/data-egress.js';
import { portSlot } from '../lib/port-slot.js';
import type { Refusal, RefusalError } from '../lib/refusal.js';
import type { KernelActor } from '../lifecycle/index.js';
import type { Actor } from './activity.js';

/** The project document as the issue kernel reads it. */
export interface IssueProjectDocument {
  environments: Record<string, { tier: string }>;
  source: {
    type: 'git' | 'storefront' | 'none';
    storefront?: { provider: string; binding: string };
  };
  delivery?: Parameters<typeof verdictsRequiredOf>[0];
  plan?: { approval: { required: boolean } } | undefined;
  /** The language the project writes the prose it stores in Forge in; absent means `en`. */
  contentLanguage?: string | undefined;
}

/** Whether the issue's requirement moved since its plan was written; null when it delivers none. */
interface IssuePlanDrift {
  key: string;
  plannedRevision: number | null;
  currentRevision: number | null;
  changed: boolean;
  changedCriteria: { code: string; revision: number }[];
  detail: string;
}

export type StorefrontDraftReading =
  | { readonly kind: 'read'; readonly draftVersion: string; readonly workflowCode: string }
  | { readonly kind: 'missing'; readonly detail: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

export interface HostCommit {
  sha: string;
  message: string;
  committedAt: string | null;
}

/** The repository host as a landing check reads it. */
export interface CommitHost {
  readonly fullName: string;
  readonly provider: string;
  readCommit(sha: string): Promise<HostCommit | null>;
  branchContains(branch: string, sha: string): Promise<boolean>;
}

export interface RunnerAvailability {
  total: number;
}

export type DispatchGateCode = 'WORKFLOW_DESIGN_NOT_APPROVED' | 'CONTRACT_WAIT_UNSETTLED';

export type GateReader = Pick<Tx, 'execute' | 'select'>;

type UsageTotalsSelection = {
  estimatedCost: SQL<number>;
  inputTokens: SQL<number>;
  outputTokens: SQL<number>;
  cacheReadTokens: SQL<number>;
  cacheCreationTokens: SQL<number>;
  requests: SQL<number>;
  sampleCount: SQL<number>;
};

type UsageTotals = { readonly [K in keyof UsageTotalsSelection]: number };

interface StoredFiles {
  put(key: string, data: Buffer | Uint8Array, mime: string): Promise<{ path: string }>;
  get(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
}

/** A question answered on an issue, with what the answer said and did (`questions/answer-outcome.ts`). */
export interface AnsweredQuestion {
  questionId: string;
  answeredAt: string;
  hold: AnswerHold | null;
  resume: AnswerResume | null;
}

interface IssuePorts {
  projectCreatorOf: (projectId: string) => Promise<string | null>;
  settleOpenQuestions: (
    tx: Tx,
    args: {
      issueId: string;
      toStatus: IssueStatus;
      voidQuestions?: string | undefined;
      requireNoOpenQuestions?: boolean | undefined;
      by: string;
      actor: KernelActor;
    },
  ) => Promise<{
    code: 'OPEN_QUESTIONS' | 'VOID_REASON_REQUIRED';
    detail: string;
    details: Record<string, unknown>;
  } | null>;
  holdsOpenHumanQuestion: (issueId: SQLWrapper) => SQL;
  personOwesAnAnswer: (executor: Tx, issueId: string) => Promise<boolean>;
  askParkQuestion: (
    executor: Tx,
    input: {
      id: string;
      projectId: string;
      issueId: string;
      prompt: string;
      needed?: string | undefined;
      /** The design revision whose decision answers the question (ISS-254). */
      awaitsDesign?: { workflowId: string; revision: number } | undefined;
      /** Core linked `awaitsDesign` as the one revision proposed under this issue. */
      linkedUnderIssue?: boolean | undefined;
      /** The issue whose merge mark answers the question. */
      awaitsMerge?: { issueId: string } | undefined;
    },
  ) => Promise<unknown>;
  /** Answer the open questions waiting on this issue's mark, in the stamp's transaction. */
  answerMergeQuestions: (
    executor: Tx,
    args: {
      issueId: string;
      mark: { mergedAt: Date | string | null; commitSha: string | null; landing: string | null };
      actor: OutboxActor | null;
    },
  ) => Promise<string[]>;
  /** The one design revision proposed under the issue still awaiting its approver; refused when several are. */
  pendingDesignOfPark: (
    executor: Tx,
    projectId: string,
    issueId: string,
  ) => Promise<{ workflowId: string; revision: number; flow: string } | null>;
  openHumanQuestionIdsOn: (executor: Tx, issueId: string) => Promise<string[]>;
  /** The question answered most recently on this issue after `after`, with what its answer did (ISS-258). */
  answeredSince: (
    executor: Tx,
    issueId: string,
    after: Date | null,
  ) => Promise<AnsweredQuestion | null>;
  /** `answeredSince` as SQL over a page of issues: a jsonb of the same shape, or null. */
  answeredSinceSql: (issueId: SQLWrapper, after: SQLWrapper) => SQL;
  postIssueNotice: (
    notice: {
      issueId: string;
      authorId: string;
      body: string;
      intent?: 'note' | 'question';
      authorsWords?: boolean;
    },
    tx?: Tx,
  ) => Promise<{ id: string; body: string; parentId: string | null }>;
  messageRefusalHttp: (err: unknown) => RefusalError | null;

  readProjectDocument: (projectId: string) => Promise<{ document: IssueProjectDocument } | null>;
  planDriftOf: (executor: Pick<Tx, 'execute'>, issueId: string) => Promise<IssuePlanDrift | null>;
  changedTracedOf: (
    executor: Pick<Tx, 'execute'>,
    issueIds: readonly string[],
  ) => Promise<Map<string, { code: string; revision: number }[]>>;
  readLandingBranches: (
    projectId: string,
  ) => Promise<{ defaultBranch: string | null; promoted: string | null }>;
  issueRefPattern: (prefixes: readonly string[]) => RegExp;
  declaredIssueSeqs: (message: string, pattern: RegExp, baseBranch: string) => number[];
  subjectOf: (message: string) => string;
  liveReachForIssue: (
    issue: {
      projectId: string;
      issSeq: number;
      mergedAt: Date | string | null;
      mergedCommitSha: string | null;
    },
    prefixes: readonly string[],
  ) => Promise<object | null>;

  getLoopThresholds: () => { queueMs: number; heartbeatMs: number; ackMs: number };
  extractStageStatus: (payload: unknown) => string | null;
  freshRunnerAvailability: (projectId: string) => Promise<RunnerAvailability>;
  usageSessionMatch: (target: SQL) => SQL;
  usageTotalsSelection: () => UsageTotalsSelection;
  emptyUsageTotals: UsageTotals;
  fireOfCaller: (caller: {
    deviceId: string | null;
    boundProjectId: string | null;
  }) => Promise<string | null>;
  /** The chat door a credential was minted for, or null for any other (`agent-sessions/chat-door.ts`). */
  chatDoorOfToken: (tokenId: string) => Promise<{ door: 'assistant-turn' | 'box-session' } | null>;
  issueDeleteRefusal: (issue: {
    id: string;
    projectId: string;
    issSeq: number;
  }) => Promise<Refusal | null>;

  designUnapprovedSql: (issueId: SQL) => SQL;
  assertDesignsApprovedForSeqs: (projectId: string, seqs: readonly number[]) => Promise<void>;
  assertDesignApprovedForIssue: (
    projectId: string,
    issueId: string,
    executor?: GateReader,
  ) => Promise<void>;
  /** Why the design gate holds each of these issues, by issue id; an issue it does not hold is absent. */
  designHoldsOf: (projectId: string, issueIds: readonly string[]) => Promise<Map<string, string>>;
  buildsWorkflowOf: (issueId: string) => Promise<unknown>;
  /** The newest approved version of the provider's contract at or above `minVersion` in its own scheme; null while none is. */
  settlingContractVersion: (
    executor: Tx,
    providerProjectId: string,
    contractSlug: string,
    minVersion: string,
  ) => Promise<string | null>;
  proposesWorkflowOf: (issueId: string) => Promise<object | null>;
  requirementOfIssue: (issueId: string) => Promise<object | null>;
  /** The issue's requirement and its criterion wordings, which a `(REQ-n BC-m)` trace resolves against. */
  traceWordingsOf: (
    tx: Tx,
    issueId: string,
  ) => Promise<{
    requirement: { seq: number; revision: number | null } | null;
    wordings: { id: string; code: string; sinceRevision: number; retiredRevision: number | null }[];
  }>;
  /** Of these traced wordings, the live ones of the issue's own requirement, as `REQ-n BC-m`. */
  liveTracedCodesOf: (tx: Tx, issueId: string, ids: readonly string[]) => Promise<string[]>;
  /** The release that shipped the issue, by version and when; null while none has. */
  shippedReleaseOf: (
    projectId: string,
    issueId: string,
  ) => Promise<{ version: string; at: string } | null>;
  plannedRevisionFor: (
    tx: Tx,
    issueId: string,
    plan: string | null,
  ) => Promise<{ plannedRevision: number | null } | null>;
  approvalRequired: (projectId: string) => Promise<boolean>;
  /** The project's policy read once: the refusal a dispatch at a status would meet, or null. */
  policyGapsOf: (
    projectId: string,
  ) => Promise<(status: string) => { code: PolicyRefusalCode; detail: string } | null>;
  contractDrift: (
    issue: {
      projectId: string;
      description: string | null;
      plan: string | null;
      acceptanceCriteria: string | null;
    },
    landed: readonly string[],
  ) => Promise<{ code: 'CONTRACT_DRIFT' | 'CONTRACT_LANDING_UNNAMED'; detail: string } | null>;

  guideRef: (slug: 'pipeline-and-issue-lifecycle') => string;
  deleteMemory: (projectId: string, source: 'issue', sourceRef: string) => Promise<number>;
  runMemorySearch: (input: {
    projectId: string;
    query: string;
    topK?: number | undefined;
    sourceFilter: ['issue'];
    strategy: 'semantic';
    surface: 'web';
    queryVec: number[];
  }) => Promise<{
    hits: Array<{ id: string; sourceRef: unknown; score: unknown; stale: unknown }>;
  }>;
  embedBatch: (scope: EgressScope, texts: string[]) => Promise<number[][]>;

  getStorage: () => StoredFiles;
  isEnoent: (err: unknown) => boolean;
  resolveSourceHost: (projectId: string, as: 'kernel') => Promise<CommitHost>;
  isSourceHostUnavailable: (err: unknown) => err is Error;
  readStorefrontDrafts: (args: {
    provider: string;
    binding: string;
    workflowIds: readonly string[];
  }) => Promise<Map<string, StorefrontDraftReading>>;
  /** The issue's step handoffs, oldest first. */
  handoffContextsOf: (
    projectId: string,
    issueId: string,
  ) => Promise<
    Array<{
      id: string;
      step: string | null;
      attempt: number;
      pipelineRunId: string;
      payload: unknown;
      createdAt: Date;
      updatedAt: Date;
    }>
  >;
  closeOpenRunForIssue: (
    issueId: string,
    outcome: 'completed' | 'cancelled',
  ) => Promise<'settled' | 'deferred'>;
  triggerPipelineStepManual: (args: {
    projectId: string;
    issueId: string;
    status: IssueStatus;
    actor: Actor;
    reason: Record<string, unknown>;
  }) => Promise<{ startedAt: string }>;
}

const slot = portSlot<IssuePorts>('issues', 'provideIssuePorts');
export const provideIssuePorts = slot.provide;
const issuePorts = slot.get;
const { port } = slot;

export const projectCreatorOf = port('projectCreatorOf');

export const settleOpenQuestions = port('settleOpenQuestions');
export const holdsOpenHumanQuestion = port('holdsOpenHumanQuestion');
export const personOwesAnAnswer = port('personOwesAnAnswer');
export const askParkQuestion = port('askParkQuestion');
export const pendingDesignOfPark = port('pendingDesignOfPark');
export const answerMergeQuestions = port('answerMergeQuestions');
export const openHumanQuestionIdsOn = port('openHumanQuestionIdsOn');
export const answeredSince = port('answeredSince');
export const answeredSinceSql = port('answeredSinceSql');
export const postIssueNotice = port('postIssueNotice');
export const messageRefusalHttp = port('messageRefusalHttp');

export const readProjectDocument = port('readProjectDocument');
export const planDriftOf = port('planDriftOf');
export const changedTracedOf = port('changedTracedOf');
export const readLandingBranches = port('readLandingBranches');
export const issueRefPattern = port('issueRefPattern');
export const declaredIssueSeqs = port('declaredIssueSeqs');
export const subjectOf = port('subjectOf');
export const liveReachOfIssue = port('liveReachForIssue');

export const getLoopThresholds = port('getLoopThresholds');
export const extractStageStatus = port('extractStageStatus');
export const freshRunnerAvailability = port('freshRunnerAvailability');
export const usageSessionMatch = port('usageSessionMatch');
export const usageTotalsSelection = port('usageTotalsSelection');
export const emptyUsageTotals = (): UsageTotals => issuePorts().emptyUsageTotals;
export const fireOfCaller = port('fireOfCaller');
export const chatDoorOfToken = port('chatDoorOfToken');
export const issueDeleteRefusal = port('issueDeleteRefusal');

export const designUnapprovedSql = port('designUnapprovedSql');
export const assertDesignsApprovedForSeqs = port('assertDesignsApprovedForSeqs');
export const assertDesignApprovedForIssue = port('assertDesignApprovedForIssue');
export const designHoldsOf = port('designHoldsOf');
export const buildsWorkflowOf = port('buildsWorkflowOf');
export const settlingContractVersion = port('settlingContractVersion');
export const proposesWorkflowOf = port('proposesWorkflowOf');
export const requirementOfIssue = port('requirementOfIssue');
export const traceWordingsOf = port('traceWordingsOf');
export const liveTracedCodesOf = port('liveTracedCodesOf');
export const shippedReleaseOf = port('shippedReleaseOf');
export const plannedRevisionFor = port('plannedRevisionFor');
export const approvalRequired = port('approvalRequired');
export const policyGapsOf = port('policyGapsOf');
export const contractDrift = port('contractDrift');

export const guideRef = port('guideRef');
export const deleteMemory = port('deleteMemory');
export const runMemorySearch = port('runMemorySearch');
export const embedBatch = port('embedBatch');

export const getStorage = port('getStorage');
export const isEnoent = port('isEnoent');
export const resolveSourceHost = port('resolveSourceHost');
export const isSourceHostUnavailable = port('isSourceHostUnavailable');
export const readStorefrontDrafts = port('readStorefrontDrafts');
export const handoffContextsOf = port('handoffContextsOf');
export const closeOpenRunForIssue = port('closeOpenRunForIssue');
export const triggerPipelineStepManual = port('triggerPipelineStepManual');
