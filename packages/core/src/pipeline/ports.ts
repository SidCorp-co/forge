// What the pipeline needs from modules it may not import: execution (jobs, sessions, devices,
// runners, usage), conversations (notifications, the project's agent handle), operations (metrics),
// the domains of its own context (comments, questions, labels), the project document, and the
// tables other modules keep retention rules for. Work is upstream of execution, so the pipeline
// declares each need here and the composition root fills it at boot (`provideProjectOrg` is the
// pattern).

import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import type { RetentionStatements } from '../db/retention-shape.js';
import type { IssueStatus, jobs, NotificationType } from '../db/schema.js';
import type { sessionInbox } from '../db/schema-session-inbox.js';
import type { Actor } from '../issues/index.js';
import type { RefusalError } from '../lib/refusal.js';
import type {
  KernelExecutor,
  MachineRow,
  TransitionArgs,
  TransitionResult,
} from '../lifecycle/index.js';

type SessionRow = MachineRow<'session'>;

export interface LoopScope {
  projectId?: string;
}

/** The project policy as the pipeline reads it: whether a person or the masters start an issue. */
export interface ProjectPolicy {
  intake: { mode: 'auto' | 'manual' };
}

export interface NotificationInput {
  userId?: string;
  recipients?: string[];
  projectId?: string | null;
  type: NotificationType;
  title: string;
  body?: string | null;
  issueId?: string | null;
  secondaryIssueId?: string | null;
  agentSessionId?: string | null;
  severity?: string | null;
  resolutionKey?: string | null;
  dedupeKey?: string | null;
  groupKey?: string | null;
  groupTitle?: string | null;
}

export interface IssueNoticeInput {
  issueId: string;
  authorId: string;
  body: string;
}

export interface HoldReading {
  reason: string;
  heldAt: string;
  autoRelease: boolean;
}

export interface AutoRetryReading {
  round: number;
  target: string | null;
  tries: number;
  done: string[];
  deferredSince?: string | null;
}

export type RunGateReading =
  | { read: 'ok'; condition: Record<string, unknown> }
  | { read: 'unreadable'; reason: string };

export interface KillableJob {
  id: string;
  deviceId: string | null;
  runnerId: string | null;
  killRequestedAt: Date | null;
  killConfirmedAt: Date | null;
  killOutcome: (typeof jobs.$inferSelect)['killOutcome'];
}

export interface PipelinePorts {
  insertJobRow: (tx: Tx, values: typeof jobs.$inferInsert) => Promise<{ id: string }>;
  wakeMastersForProject: (args: {
    projectId: string;
    issueId: string | null;
    status: IssueStatus;
  }) => Promise<{ boxes: number; delivered: number }>;
  requestSessionSend: (req: {
    agentSessionId: string;
    kind: 'answer';
    intentId: string;
    body: string;
  }) => Promise<{ published: boolean }>;
  resolveSessionSend: (
    row: typeof sessionInbox.$inferSelect,
    now: number,
  ) => Promise<{ outcome: string }>;
  transitionSessions: <K extends keyof SessionRow = keyof SessionRow>(
    exec: KernelExecutor,
    args: TransitionArgs<'session', K>,
  ) => Promise<TransitionResult<Pick<SessionRow, K | 'id'>>>;
  broadcastSessionEvent: (
    sessionId: string,
    projectId: string,
    deviceId: string | null,
    event: string,
    extra: Record<string, unknown>,
  ) => void;
  getLoopThresholds: () => { queueMs: number; heartbeatMs: number; ackMs: number };
  killGraceMs: () => number;
  parkedOnAHuman: (sessionId: SQL) => SQL;
  requestJobKill: (job: KillableJob, reason: string) => Promise<string>;
  failReconcileRunForFailedJob: (job: { type: string; payload: unknown }) => Promise<void>;
  holdPayloadKey: string;
  readHoldState: (payload: unknown) => HoldReading | null;
  holdReleasesItself: (hold: HoldReading | null, failureReason?: string | null) => boolean;
  gateReasonsForQueuedJobsIn: (
    projectIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  retryMaxRounds: number;
  readAutoRetryPayload: (payload: unknown) => AutoRetryReading;
  readRunGate: (metadata: unknown, runId: string) => RunGateReading | null;
  admittedRunner: SQL;
  usageSessionMatch: (target: SQL) => SQL;
  deriveSessionFinal: (jobId: string, agentSessionId: string) => Promise<void>;
  stampFinalizeAttempt: (agentSessionId: string, at: Date) => Promise<void>;
  retentionStatements: RetentionStatements;

  emitNotification: (input: NotificationInput) => Promise<{ id: string; delivered: number } | null>;
  createNotification: (
    input: NotificationInput,
  ) => Promise<{ id: string; delivered: number } | null>;
  resolveNotifications: (resolutionKey: string, outcome?: string) => Promise<number>;
  projectAdminUserIds: (projectId: string) => Promise<string[]>;
  projectAdminUserIdsFor: (projectIds: readonly string[]) => Promise<Map<string, string[]>>;
  existingProjectHandle: (tx: Tx, projectId: string) => Promise<{ userId: string } | undefined>;
  resolveProjectHandle: (tx: Tx, projectId: string, mintAs?: string) => Promise<{ userId: string }>;
  retryRescuesSince: (projectIds: readonly string[] | null, since: SQL) => SQL;
  buildInterventionsReport: (projectIds: readonly string[], days: number) => Promise<object>;

  postIssueNotice: (notice: IssueNoticeInput, tx?: Tx) => Promise<unknown>;
  postIssueNoticeOnce: (notice: IssueNoticeInput & { marker: string }) => Promise<unknown>;
  holdsOpenHumanQuestion: (issueId: SQLWrapper) => SQL;
  personOwesAnAnswer: (executor: Tx, issueId: string) => Promise<boolean>;
  refreshModuleKnowledgeForIssue: (input: {
    issueId: string;
    projectId: string;
    actor: Actor;
  }) => Promise<void>;

  readEffectivePolicy: (projectId: string) => Promise<{ document: ProjectPolicy } | null>;
  policyRefusal: (
    code: 'POLICY_UNDECLARED',
    projectId: string,
    status: string | null,
  ) => RefusalError;
  readLandingBranches: (
    projectId: string,
  ) => Promise<{ defaultBranch: string | null; promoted: string | null }>;
}

let ports: PipelinePorts | null = null;

export function providePipelinePorts(given: PipelinePorts): void {
  ports = given;
}

export function pipelinePorts(): PipelinePorts {
  if (!ports) {
    throw new Error(
      'pipeline: no ports were provided; the process entry calls providePipelinePorts before it serves',
    );
  }
  return ports;
}

export const SWEEP_SESSION_COLUMNS = [
  'id',
  'projectId',
  'deviceId',
  'pipelineRunId',
  'status',
] as const satisfies readonly (keyof SessionRow)[];

export const insertJobRow: PipelinePorts['insertJobRow'] = (tx, values) =>
  pipelinePorts().insertJobRow(tx, values);
export const wakeMastersForProject: PipelinePorts['wakeMastersForProject'] = (args) =>
  pipelinePorts().wakeMastersForProject(args);
export const requestSessionSend: PipelinePorts['requestSessionSend'] = (req) =>
  pipelinePorts().requestSessionSend(req);
export const resolveSessionSend: PipelinePorts['resolveSessionSend'] = (row, now) =>
  pipelinePorts().resolveSessionSend(row, now);
export const transitionSessions: PipelinePorts['transitionSessions'] = (exec, args) =>
  pipelinePorts().transitionSessions(exec, args);
export const broadcastSessionEvent: PipelinePorts['broadcastSessionEvent'] = (...args) =>
  pipelinePorts().broadcastSessionEvent(...args);
export const getLoopThresholds: PipelinePorts['getLoopThresholds'] = () =>
  pipelinePorts().getLoopThresholds();
export const killGraceMs: PipelinePorts['killGraceMs'] = () => pipelinePorts().killGraceMs();
export const parkedOnAHuman: PipelinePorts['parkedOnAHuman'] = (sessionId) =>
  pipelinePorts().parkedOnAHuman(sessionId);
export const requestJobKill: PipelinePorts['requestJobKill'] = (job, reason) =>
  pipelinePorts().requestJobKill(job, reason);
export const failReconcileRunForFailedJob: PipelinePorts['failReconcileRunForFailedJob'] = (job) =>
  pipelinePorts().failReconcileRunForFailedJob(job);
export const holdPayloadKey = (): string => pipelinePorts().holdPayloadKey;
export const readHoldState: PipelinePorts['readHoldState'] = (payload) =>
  pipelinePorts().readHoldState(payload);
export const holdReleasesItself: PipelinePorts['holdReleasesItself'] = (hold, failureReason) =>
  pipelinePorts().holdReleasesItself(hold, failureReason);
export const gateReasonsForQueuedJobsIn: PipelinePorts['gateReasonsForQueuedJobsIn'] = (ids) =>
  pipelinePorts().gateReasonsForQueuedJobsIn(ids);
export const retryMaxRounds = (): number => pipelinePorts().retryMaxRounds;
export const readAutoRetryPayload: PipelinePorts['readAutoRetryPayload'] = (payload) =>
  pipelinePorts().readAutoRetryPayload(payload);
export const readRunGate: PipelinePorts['readRunGate'] = (metadata, runId) =>
  pipelinePorts().readRunGate(metadata, runId);
export const admittedRunner = (): SQL => pipelinePorts().admittedRunner;
export const usageSessionMatch: PipelinePorts['usageSessionMatch'] = (target) =>
  pipelinePorts().usageSessionMatch(target);
export const deriveSessionFinal: PipelinePorts['deriveSessionFinal'] = (jobId, sessionId) =>
  pipelinePorts().deriveSessionFinal(jobId, sessionId);
export const stampFinalizeAttempt: PipelinePorts['stampFinalizeAttempt'] = (sessionId, at) =>
  pipelinePorts().stampFinalizeAttempt(sessionId, at);
export const retentionStatements = (): RetentionStatements => pipelinePorts().retentionStatements;

export const emitNotification: PipelinePorts['emitNotification'] = (input) =>
  pipelinePorts().emitNotification(input);
export const createNotification: PipelinePorts['createNotification'] = (input) =>
  pipelinePorts().createNotification(input);
export const resolveNotifications: PipelinePorts['resolveNotifications'] = (key, outcome) =>
  pipelinePorts().resolveNotifications(key, outcome);
export const projectAdminUserIds: PipelinePorts['projectAdminUserIds'] = (projectId) =>
  pipelinePorts().projectAdminUserIds(projectId);
export const projectAdminUserIdsFor: PipelinePorts['projectAdminUserIdsFor'] = (projectIds) =>
  pipelinePorts().projectAdminUserIdsFor(projectIds);
export const existingProjectHandle: PipelinePorts['existingProjectHandle'] = (tx, projectId) =>
  pipelinePorts().existingProjectHandle(tx, projectId);
export const resolveProjectHandle: PipelinePorts['resolveProjectHandle'] = (tx, projectId, as) =>
  pipelinePorts().resolveProjectHandle(tx, projectId, as);
export const retryRescuesSince: PipelinePorts['retryRescuesSince'] = (projectIds, since) =>
  pipelinePorts().retryRescuesSince(projectIds, since);
export const buildInterventionsReport: PipelinePorts['buildInterventionsReport'] = (ids, days) =>
  pipelinePorts().buildInterventionsReport(ids, days);

export const postIssueNotice: PipelinePorts['postIssueNotice'] = (notice, tx) =>
  pipelinePorts().postIssueNotice(notice, tx);
export const postIssueNoticeOnce: PipelinePorts['postIssueNoticeOnce'] = (notice) =>
  pipelinePorts().postIssueNoticeOnce(notice);
export const holdsOpenHumanQuestion: PipelinePorts['holdsOpenHumanQuestion'] = (issueId) =>
  pipelinePorts().holdsOpenHumanQuestion(issueId);
export const personOwesAnAnswer: PipelinePorts['personOwesAnAnswer'] = (executor, issueId) =>
  pipelinePorts().personOwesAnAnswer(executor, issueId);
export const refreshModuleKnowledgeForIssue: PipelinePorts['refreshModuleKnowledgeForIssue'] = (
  input,
) => pipelinePorts().refreshModuleKnowledgeForIssue(input);

export const readEffectivePolicy: PipelinePorts['readEffectivePolicy'] = (projectId) =>
  pipelinePorts().readEffectivePolicy(projectId);
export const policyRefusal: PipelinePorts['policyRefusal'] = (code, projectId, status) =>
  pipelinePorts().policyRefusal(code, projectId, status);
export const readLandingBranches: PipelinePorts['readLandingBranches'] = (projectId) =>
  pipelinePorts().readLandingBranches(projectId);
