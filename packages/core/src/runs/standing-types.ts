import type { IssueStatus } from '@forge/contracts/issue-machine';
import type { WorkStep } from '@forge/contracts/issue-vocabulary';
import type {
  RunActor,
  RunDeployLock,
  RunDevice,
  RunIssueRef,
  RunNone,
  RunOutcome,
  RunState,
  RunWaitingKind,
} from '@forge/contracts/run-standing';
import { nobodyWaits, type WaitingOn } from '@forge/contracts/standing';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import type { HoldState } from '../jobs/index.js';
import type { PipelineRunLane } from '../pipeline/index.js';

export interface KernelFlip {
  toStatus: string;
  reason: string | null;
  actorType: RunActor['type'];
  agency: RunActor['agency'];
  userId: string | null;
  name: string | null;
  at: Date;
}

export interface RunFacts {
  run: {
    id: string;
    projectId: string;
    rawLane: PipelineRunLane;
    status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
    startedAt: Date;
    finishedAt: Date | null;
    updatedAt: Date;
    currentStep: string | null;
    openPhase: string | undefined;
    pauseReason: string | null;
    releaseVersion: string | null;
  };
  issue:
    | (RunIssueRef & {
        id: string;
        statusSince: Date | null;
        strand: { at: Date; status: string; reason: string } | null;
      })
    | null;
  issues: string[];
  openingStatuses: Record<string, string>;
  endStatuses: Record<string, IssueStatus>;
  workState: { step: WorkStep | null; stepStartedAt: Date | null; lease: unknown } | null;
  session: {
    id: string;
    status: string;
    runtimeState: string | null;
    failureReason: string | null;
    failureDetail: string | null;
    lastHeartbeatAt: Date | null;
    startedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    device: RunDevice | null;
    name: string | null;
  } | null;
  job: {
    id: string;
    type: string;
    status: string;
    heldBy: string | null;
    heldAt: Date | null;
    hold: HoldState | null;
    retryAfterAt: Date | null;
    failureReason: string | null;
    queuedAt: Date;
    dispatchedAt: Date | null;
    ackedAt: Date | null;
    finishedAt: Date | null;
    device: RunDevice | null;
    agentSessionId: string | null;
    sessionBeat: Date | null;
    sessionFailureReason: string | null;
    sessionFailureDetail: string | null;
    sessionStatus: string | null;
    sessionRuntimeState: string | null;
    sessionStartedAt: Date | null;
    sessionUpdatedAt: Date | null;
    sessionCreatedAt: Date | null;
    sessionDispatchedAt: Date | null;
    sessionKind: string | null;
    /** The newest job event or run phase, else the dispatch: what the result hop measures quiet from. */
    lastProgressAt: Date | null;
    sessionHeartbeatReaped: boolean;
    hasEvents: boolean;
    hasResult: boolean;
  } | null;
  liveJobs: number;
  lastBeatAt: Date | null;
  ledger: {
    incarnation: string;
    work: string;
    blockerKind: string | null;
    waitingOn: string | null;
    observedAt: Date;
  } | null;
  fleetKeys: Array<{ issueKey: string; sessionId: string; acquiredAt: Date }>;
  deployLocks: Array<
    Omit<RunDeployLock, 'acquiredAt' | 'expiresAt'> & {
      acquiredAt: Date;
      expiresAt: Date;
      held: boolean;
    }
  >;
  question: { id: string; createdAt: Date; admin: boolean; issueKey: string | null } | null;
  approval: { id: string; requestedAt: Date } | null;
  releaseAttempt: { stage: string; verdict: string | null; startedAt: Date } | null;
  runFlip: KernelFlip | null;
  sessionFlip: KernelFlip | null;
  master: { sessionId: string; name: string | null; live: boolean; lastBeatAt: Date | null } | null;
  pass: { id: string; verb: string; startedAt: Date } | null;
  attempt: { n: number; retryOf: string | null; of: string } | null;
}

export interface StandingContext {
  now: Date;
  viewer: { canWrite: boolean; isAdmin: boolean } | null;
  slots: { inUse: number; max: number } | null;
  stuckAfterMs: number;
  /** Why dispatch skips each queued job of the project now (`jobs:gateReasonsForQueuedJobsIn`), by job id:
   *  the same reading pipeline health's `waitingOn.reason` comes from. */
  queuedGates: ReadonlyMap<string, string>;
  silenceReapMs: number;
  jobHeartbeatMs: number;
  jobAckMs: number;
  jobQueueMs: number;
  resultQuietMs: number;
  killGraceMs: number;
}

export const TERMINAL_SESSION: readonly string[] = terminalAgentSessionStatuses;

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const none = (detail: string): RunNone => ({ source: 'none', detail });
export const after = (d: Date, ms: number) => new Date(d.getTime() + ms);

export interface Derived {
  state: RunState;
  since: Date | null;
  rule: string;
  outcome: RunOutcome | null;
  waitingOn: RunWaitingOn;
}

export type RunWaitingOn = WaitingOn<RunWaitingKind>;

export const NO_WAIT = nobodyWaits;

export const runWait = (
  kind: RunWaitingKind,
  who: string,
  act: string,
  rule: string,
  extra: { ref?: string | null; dueAt?: string | null } = {},
): RunWaitingOn => ({ kind, who, act, rule, ref: extra.ref ?? null, dueAt: extra.dueAt ?? null });
