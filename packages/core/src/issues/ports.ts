// What the issue kernel needs from modules it may not import: the domains of its own context
// (questions, comments), the project document and the projects domain, execution (jobs, sessions,
// usage, agent reports), the design and release domains, knowledge, and the adapters (storage,
// embeddings, the source host, a storefront). A kernel imports only kernels and the platform, so
// each need is declared here and the composition root fills it at boot (`provideProjectOrg` is the
// pattern).

import type { verdictsRequiredOf } from '@forge/contracts/delivery-policy';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { IssueStatus } from '../db/schema.js';
import type { EgressScope } from '../lib/data-egress.js';
import type { Refusal, RefusalError } from '../lib/refusal.js';
import type { KernelActor } from '../lifecycle/index.js';

/** The project document as the issue kernel reads it. */
export interface IssueProjectDocument {
  environments: Record<string, { tier: string }>;
  source: {
    type: 'git' | 'storefront' | 'none';
    storefront?: { provider: string; binding: string };
  };
  delivery?: Parameters<typeof verdictsRequiredOf>[0];
  plan?: { approval: { required: boolean } } | undefined;
}

/** Whether the issue's requirement moved since its plan was written; null when it delivers none. */
interface IssuePlanDrift {
  key: string;
  plannedRevision: number | null;
  currentRevision: number | null;
  changed: boolean;
  repinned: boolean;
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

export type DispatchGateCode = 'WORKFLOW_DESIGN_NOT_APPROVED';

export interface DispatchGateError extends Error {
  readonly code: DispatchGateCode;
  readonly blocked: readonly unknown[];
}

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

interface IssuePorts {
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
    input: { id: string; projectId: string; issueId: string; prompt: string; needed: string },
  ) => Promise<unknown>;
  openHumanQuestionIdsOn: (executor: Tx, issueId: string) => Promise<string[]>;
  postIssueNotice: (
    notice: { issueId: string; authorId: string; body: string; intent?: 'note' | 'question' },
    tx?: Tx,
  ) => Promise<{ id: string; body: string; parentId: string | null }>;
  messageRefusalHttp: (err: unknown) => RefusalError | null;

  readProjectDocument: (projectId: string) => Promise<{ document: IssueProjectDocument } | null>;
  planDriftOf: (executor: Pick<Tx, 'execute'>, issueId: string) => Promise<IssuePlanDrift | null>;
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
  issueDeleteRefusal: (issue: {
    id: string;
    projectId: string;
    issSeq: number;
  }) => Promise<Refusal | null>;
  steerIssue: (
    issueId: string,
    body: string,
    opts: { actorUserId: string; actorAgency: ActorAgency; reason: string; source: 'rest' },
  ) => Promise<object>;

  designUnapprovedSql: (issueId: SQL) => SQL;
  assertDesignsApprovedForSeqs: (projectId: string, seqs: readonly number[]) => Promise<void>;
  assertDesignApprovedForIssue: (
    projectId: string,
    issueId: string,
    executor?: GateReader,
  ) => Promise<void>;
  isDispatchGateError: (err: unknown) => err is DispatchGateError;
  buildsWorkflowOf: (issueId: string) => Promise<unknown>;
  proposesWorkflowOf: (issueId: string) => Promise<object | null>;
  requirementOfIssue: (issueId: string) => Promise<object | null>;
  plannedRevisionFor: (
    tx: Tx,
    issueId: string,
    plan: string | null,
  ) => Promise<{ plannedRevision: number | null; plannedBaselineSeq: number | null } | null>;
  approvalRequired: (projectId: string) => Promise<boolean>;
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
  readStorefrontDraft: (args: {
    provider: string;
    binding: string;
    workflowId: string;
  }) => Promise<StorefrontDraftReading>;
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
  setCurrentStepForOpenIssueRun: (issueId: string, step: string) => Promise<void>;
  closeOpenRunForIssue: (
    issueId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
  ) => Promise<'settled' | 'deferred'>;
}

let ports: IssuePorts | null = null;

export function provideIssuePorts(given: IssuePorts): void {
  ports = given;
}

function issuePorts(): IssuePorts {
  if (!ports) {
    throw new Error(
      'issues: no ports were provided; the process entry calls provideIssuePorts before it serves',
    );
  }
  return ports;
}

export const settleOpenQuestions: IssuePorts['settleOpenQuestions'] = (tx, args) =>
  issuePorts().settleOpenQuestions(tx, args);
export const holdsOpenHumanQuestion: IssuePorts['holdsOpenHumanQuestion'] = (issueId) =>
  issuePorts().holdsOpenHumanQuestion(issueId);
export const personOwesAnAnswer: IssuePorts['personOwesAnAnswer'] = (executor, issueId) =>
  issuePorts().personOwesAnAnswer(executor, issueId);
export const askParkQuestion: IssuePorts['askParkQuestion'] = (executor, input) =>
  issuePorts().askParkQuestion(executor, input);
export const openHumanQuestionIdsOn: IssuePorts['openHumanQuestionIdsOn'] = (executor, issueId) =>
  issuePorts().openHumanQuestionIdsOn(executor, issueId);
export const postIssueNotice: IssuePorts['postIssueNotice'] = (notice, tx) =>
  issuePorts().postIssueNotice(notice, tx);
export const messageRefusalHttp: IssuePorts['messageRefusalHttp'] = (err) =>
  issuePorts().messageRefusalHttp(err);

export const readProjectDocument: IssuePorts['readProjectDocument'] = (projectId) =>
  issuePorts().readProjectDocument(projectId);
export const planDriftOf: IssuePorts['planDriftOf'] = (executor, issueId) =>
  issuePorts().planDriftOf(executor, issueId);
export const readLandingBranches: IssuePorts['readLandingBranches'] = (projectId) =>
  issuePorts().readLandingBranches(projectId);
export const issueRefPattern: IssuePorts['issueRefPattern'] = (prefixes) =>
  issuePorts().issueRefPattern(prefixes);
export const declaredIssueSeqs: IssuePorts['declaredIssueSeqs'] = (message, pattern, base) =>
  issuePorts().declaredIssueSeqs(message, pattern, base);
export const subjectOf: IssuePorts['subjectOf'] = (message) => issuePorts().subjectOf(message);
export const liveReachOfIssue: IssuePorts['liveReachForIssue'] = (issue, prefixes) =>
  issuePorts().liveReachForIssue(issue, prefixes);

export const getLoopThresholds: IssuePorts['getLoopThresholds'] = () =>
  issuePorts().getLoopThresholds();
export const extractStageStatus: IssuePorts['extractStageStatus'] = (payload) =>
  issuePorts().extractStageStatus(payload);
export const freshRunnerAvailability: IssuePorts['freshRunnerAvailability'] = (projectId) =>
  issuePorts().freshRunnerAvailability(projectId);
export const usageSessionMatch: IssuePorts['usageSessionMatch'] = (target) =>
  issuePorts().usageSessionMatch(target);
export const usageTotalsSelection: IssuePorts['usageTotalsSelection'] = () =>
  issuePorts().usageTotalsSelection();
export const emptyUsageTotals = (): UsageTotals => issuePorts().emptyUsageTotals;
export const fireOfCaller: IssuePorts['fireOfCaller'] = (caller) =>
  issuePorts().fireOfCaller(caller);
export const issueDeleteRefusal: IssuePorts['issueDeleteRefusal'] = (issue) =>
  issuePorts().issueDeleteRefusal(issue);
export const steerIssue: IssuePorts['steerIssue'] = (issueId, body, opts) =>
  issuePorts().steerIssue(issueId, body, opts);

export const designUnapprovedSql: IssuePorts['designUnapprovedSql'] = (issueId) =>
  issuePorts().designUnapprovedSql(issueId);
export const assertDesignsApprovedForSeqs: IssuePorts['assertDesignsApprovedForSeqs'] = (
  projectId,
  seqs,
) => issuePorts().assertDesignsApprovedForSeqs(projectId, seqs);
export const assertDesignApprovedForIssue: IssuePorts['assertDesignApprovedForIssue'] = (
  projectId,
  issueId,
  executor,
) => issuePorts().assertDesignApprovedForIssue(projectId, issueId, executor);
export const isDispatchGateError = (err: unknown): err is DispatchGateError =>
  issuePorts().isDispatchGateError(err);
export const buildsWorkflowOf: IssuePorts['buildsWorkflowOf'] = (issueId) =>
  issuePorts().buildsWorkflowOf(issueId);
export const proposesWorkflowOf: IssuePorts['proposesWorkflowOf'] = (issueId) =>
  issuePorts().proposesWorkflowOf(issueId);
export const requirementOfIssue: IssuePorts['requirementOfIssue'] = (issueId) =>
  issuePorts().requirementOfIssue(issueId);
export const plannedRevisionFor: IssuePorts['plannedRevisionFor'] = (tx, issueId, plan) =>
  issuePorts().plannedRevisionFor(tx, issueId, plan);
export const approvalRequired: IssuePorts['approvalRequired'] = (projectId) =>
  issuePorts().approvalRequired(projectId);
export const contractDrift: IssuePorts['contractDrift'] = (issue, landed) =>
  issuePorts().contractDrift(issue, landed);

export const guideRef: IssuePorts['guideRef'] = (slug) => issuePorts().guideRef(slug);
export const deleteMemory: IssuePorts['deleteMemory'] = (projectId, source, sourceRef) =>
  issuePorts().deleteMemory(projectId, source, sourceRef);
export const runMemorySearch: IssuePorts['runMemorySearch'] = (input) =>
  issuePorts().runMemorySearch(input);
export const embedBatch: IssuePorts['embedBatch'] = (scope, texts) =>
  issuePorts().embedBatch(scope, texts);

export const getStorage: IssuePorts['getStorage'] = () => issuePorts().getStorage();
export const isEnoent: IssuePorts['isEnoent'] = (err) => issuePorts().isEnoent(err);
export const resolveSourceHost: IssuePorts['resolveSourceHost'] = (projectId, as) =>
  issuePorts().resolveSourceHost(projectId, as);
export const isSourceHostUnavailable = (err: unknown): err is Error =>
  issuePorts().isSourceHostUnavailable(err);
export const readStorefrontDraft: IssuePorts['readStorefrontDraft'] = (args) =>
  issuePorts().readStorefrontDraft(args);
export const handoffContextsOf: IssuePorts['handoffContextsOf'] = (projectId, issueId) =>
  issuePorts().handoffContextsOf(projectId, issueId);
export const setCurrentStepForOpenIssueRun: IssuePorts['setCurrentStepForOpenIssueRun'] = (
  issueId,
  step,
) => issuePorts().setCurrentStepForOpenIssueRun(issueId, step);
export const closeOpenRunForIssue: IssuePorts['closeOpenRunForIssue'] = (issueId, outcome) =>
  issuePorts().closeOpenRunForIssue(issueId, outcome);
