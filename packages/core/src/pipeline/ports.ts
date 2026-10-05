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
import { portSlot } from '../lib/port-slot.js';
import type { RefusalError } from '../lib/refusal.js';
import type {
  KernelActor,
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

/** A run's usage totals, as agent-sessions reads them from its sessions' usage records. */
interface RunUsageTotals {
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

interface NotificationInput {
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

interface IssueNoticeInput {
  issueId: string;
  authorId: string;
  body: string;
}

export type RunGateReading =
  | { read: 'ok'; condition: Record<string, unknown> }
  | { read: 'unreadable'; reason: string };

interface KillableJob {
  id: string;
  projectId: string;
  deviceId: string | null;
  runnerId: string | null;
  killRequestedAt: Date | null;
  killConfirmedAt: Date | null;
  killOutcome: (typeof jobs.$inferSelect)['killOutcome'];
}

interface PipelinePorts {
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
  ) => Promise<void>;
  getLoopThresholds: () => { queueMs: number; heartbeatMs: number; ackMs: number };
  killGraceMs: () => number;
  parkedOnAHuman: (sessionId: SQL) => SQL;
  requestJobKill: (job: KillableJob, reason: string) => Promise<string>;
  gateReasonsForQueuedJobsIn: (
    projectIds: readonly string[],
  ) => Promise<ReadonlyMap<string, string>>;
  readRunGate: (metadata: unknown, runId: string) => RunGateReading | null;
  admittedRunner: SQL;
  usageTotalsByRun: (runIds: readonly string[]) => Promise<Map<string, RunUsageTotals>>;
  usageTotalsForRun: (runId: string) => Promise<RunUsageTotals>;
  deriveSessionFinal: (jobId: string, agentSessionId: string) => Promise<void>;
  stampFinalizeAttempt: (agentSessionId: string, at: Date) => Promise<void>;
  retentionStatements: RetentionStatements;

  emitNotification: (input: NotificationInput) => Promise<{ id: string; delivered: number }>;
  resolveNotifications: (resolutionKey: string, outcome?: string) => Promise<number>;
  projectAdminUserIds: (projectId: string) => Promise<string[]>;
  /** Who created the project: the account a system-authored act is attributed to. */
  projectCreatorOf: (projectId: string) => Promise<string | null>;
  projectAdminUserIdsFor: (projectIds: readonly string[]) => Promise<Map<string, string[]>>;
  existingProjectHandle: (tx: Tx, projectId: string) => Promise<{ userId: string } | undefined>;
  resolveProjectHandle: (tx: Tx, projectId: string, mintAs?: string) => Promise<{ userId: string }>;
  retryRescuesSince: (projectIds: readonly string[] | null, since: SQL) => SQL;

  postIssueNotice: (notice: IssueNoticeInput, tx?: Tx) => Promise<unknown>;
  postIssueNoticeOnce: (notice: IssueNoticeInput & { marker: string }) => Promise<unknown>;
  holdsOpenHumanQuestion: (issueId: SQLWrapper) => SQL;
  voidCancelledRunQuestions: (
    tx: Tx,
    args: {
      issueId: string | null;
      sessionIds: readonly string[];
      reason: string;
      actor: KernelActor;
      source: string;
    },
  ) => Promise<string[]>;
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
}

const slot = portSlot<PipelinePorts>('pipeline', 'providePipelinePorts');
export const providePipelinePorts = slot.provide;
const pipelinePorts = slot.get;
const { port } = slot;

export const SWEEP_SESSION_COLUMNS = [
  'id',
  'projectId',
  'deviceId',
  'pipelineRunId',
  'status',
] as const satisfies readonly (keyof SessionRow)[];

export const insertJobRow = port('insertJobRow');
export const wakeMastersForProject = port('wakeMastersForProject');
export const requestSessionSend = port('requestSessionSend');
export const resolveSessionSend = port('resolveSessionSend');
export const transitionSessions = port('transitionSessions');
export const broadcastSessionEvent = port('broadcastSessionEvent');
export const getLoopThresholds = port('getLoopThresholds');
export const killGraceMs = port('killGraceMs');
export const parkedOnAHuman = port('parkedOnAHuman');
export const voidCancelledRunQuestions = port('voidCancelledRunQuestions');
export const requestJobKill = port('requestJobKill');
export const gateReasonsForQueuedJobsIn = port('gateReasonsForQueuedJobsIn');
export const readRunGate = port('readRunGate');
export const admittedRunner = (): SQL => pipelinePorts().admittedRunner;
export const usageTotalsByRun = port('usageTotalsByRun');
export const usageTotalsForRun = port('usageTotalsForRun');
export const deriveSessionFinal = port('deriveSessionFinal');
export const stampFinalizeAttempt = port('stampFinalizeAttempt');
export const retentionStatements = (): RetentionStatements => pipelinePorts().retentionStatements;

export const emitNotification = port('emitNotification');
export const resolveNotifications = port('resolveNotifications');
export const projectAdminUserIds = port('projectAdminUserIds');
export const projectCreatorOf = port('projectCreatorOf');
export const projectAdminUserIdsFor = port('projectAdminUserIdsFor');
export const existingProjectHandle = port('existingProjectHandle');
export const resolveProjectHandle = port('resolveProjectHandle');
export const retryRescuesSince = port('retryRescuesSince');

export const postIssueNotice = port('postIssueNotice');
export const postIssueNoticeOnce = port('postIssueNoticeOnce');
export const holdsOpenHumanQuestion = port('holdsOpenHumanQuestion');
export const personOwesAnAnswer = port('personOwesAnAnswer');
export const refreshModuleKnowledgeForIssue = port('refreshModuleKnowledgeForIssue');

export const readEffectivePolicy = port('readEffectivePolicy');
export const policyRefusal = port('policyRefusal');
