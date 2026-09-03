// ISS-831 — HooksBus.emit never throws: every subscriber runs, in registration
// order, even when an earlier one fails. A subscriber that throws is logged
// AND recorded in the returned EmitResult.failures; best-effort subscribers
// (the majority — they already self-catch) never appear there. Callers that
// can act on a failure inspect `result.failures` (today: only
// `outbox-worker.ts`, via `assertHookDelivered`); every other one of the ~48
// call sites ignores the return value and keeps today's fire-and-forget
// behaviour, because most fire after their primary mutation already
// committed and a throw here would turn a successful write into a 500.

import type {
  IssueDependencyKind,
  IssueStatus,
  JobType,
  PipelineRunKind,
  PipelineRunStatus,
} from '../db/schema.js';
import { logger } from '../logger.js';
import type { Actor } from './activity.js';

export interface IssueSnapshot {
  title: string;
  description: string | null;
  // cm:edge contract -> packages/core/src/memory/indexer.ts — the indexer projects `description` through the body registry and needs the format to pick a path. OPTIONAL because absent degrades to the raw body rather than throwing; `body/doors.test.ts` is what asserts the two real producers set it.
  descriptionFormat?: string;
  priority: string;
  category: string | null;
  reportedBy: string | null;
  assigneeId: string | null;
  labels: string[];
}

export interface HookPayloads {
  issueCreated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    // ISS-130 — the inserted row's status. The orchestrator's issueCreated
    // subscriber forwards this to considerEnqueue so decomposition children
    // created at `on_hold` do not auto-dispatch forge-triage.
    status: IssueStatus;
    snapshot: IssueSnapshot;
  };
  issueUpdated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    fields: string[];
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  transition: {
    issueId: string;
    projectId: string;
    actor: Actor;
    from: IssueStatus;
    to: IssueStatus;
    reason?: string;
    reopenCount: number;
    /**
     * ISS-849 — the `pipeline_outbox` row id this delivery came from, when the
     * transition was emitted via the outbox drain. Optional/fail-open: absent
     * for any other emitter, in which case redelivery-dedup is skipped and
     * behavior is unchanged. Unique per logical transition, so it collapses
     * redeliveries of the same row without suppressing two independent
     * transitions through the same `from`/`to` states.
     */
    outboxId?: string;
  };
  // ISS-20 (Epic 4) — terminal job lifecycle events. PM subscribers branch on
  // `failureKind` so they react differently per class (ISS-450 taxonomy:
  // code/infra/transient-cc/timeout). Emitted from `jobs/lifecycle-routes.ts`
  // after `scheduleRetry` writes the classification onto the row.
  jobFailed: {
    jobId: string;
    projectId: string;
    issueId: string | null;
    type: JobType;
    failureKind: 'code' | 'infra' | 'transient-cc' | 'timeout' | null;
    failureReason: string | null;
  };
  jobCompleted: {
    jobId: string;
    projectId: string;
    issueId: string | null;
    type: JobType;
  };
  // ISS-20 (Epic 4) — dependency graph mutation. Fire-and-forget; carries
  // enough to trigger a graph re-read but not the full graph.
  dependencyChanged: {
    projectId: string;
    edgeId: string;
    fromIssueId: string;
    toIssueId: string;
    kind: IssueDependencyKind;
  };
  commentCreated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    commentId: string;
    body: string;
    // Optional: existing emit sites pre-date threading. Treat undefined and
    // null as "top-level". The activity logger only records this when set.
    parentId?: string | null;
  };
  commentUpdated: {
    issueId: string;
    projectId: string;
    actor: Actor;
    commentId: string;
    before: string;
    after: string;
  };
  commentDeleted: {
    issueId: string;
    projectId: string;
    actor: Actor;
    commentId: string;
  };
  commentMentioned: {
    issueId: string;
    projectId: string;
    commentId: string;
    actor: Actor;
    mentionedUserIds: string[];
  };
  skillSynced: {
    projectId: string;
    deviceId: string;
    added: string[];
    updated: string[];
    unchanged: string[];
    removed: string[];
  };
  // Explicit, user-initiated skill push. Fired only from the two web Sync
  // actions (Skill Studio + device management) and the `forge_skills.push`
  // MCP tool — never automatically. The WS bridge publishes `skill.sync` to
  // each targeted `deviceRoom`, and the device (desktop or CLI runner) pulls
  // its effective manifest and reports installed hashes back. There is NO
  // background/auto sync: a device only syncs when it receives this command.
  skillSyncRequested: {
    projectId: string;
    projectSlug: string;
    deviceIds: string[];
    skillNames: string[] | null;
    actorUserId: string;
  };
  skillRegistered: {
    projectId: string;
    skillId: string;
    actorUserId: string;
    stage: string | null;
  };
  // A (device × project) runner was bound/re-provisioned. The WS bridge wakes
  // the device room with `provision.request` (best-effort) so an online device
  // pulls promptly; the durable source of truth is the `queued` row the device
  // pulls via GET /api/devices/me/provisions. Carries no secret — the device
  // pulls the (decrypted, single-use) SSH key + clone target itself.
  runnerProvisionRequested: {
    projectId: string;
    deviceId: string;
    runnerId: string;
  };
  // cm:edge protocol -> packages/core/src/jobs/dispatch-subscribers.ts — the ONLY subscriber that turns this into a dispatch tick; heartbeat-ws emits it instead of calling the dispatcher so the WS layer does not import the job layer, and with no subscriber registered a runner coming online waits for the sweeper's backstop instead of dispatching at once
  runnerOnline: {
    projectId: string;
    runnerId: string;
  };
  // A device reported provision progress; bridge to the project room so web's
  // runner views update the live stepper.
  runnerProvisionStatus: {
    projectId: string;
    runnerId: string;
    deviceId: string;
    status: string;
    detail: string | null;
  };
  // v1 EPIC 6 — fired when a project skill override is created, updated, or
  // deleted. The WS broadcaster bridges this to the `skill.updated` event in
  // the project room so the web Skills page can invalidate its cache and the
  // packages/dev sync engine (PR-c) can resync the affected SKILL.md file.
  skillUpdated: {
    projectId: string;
    skillId: string;
    name: string;
    action: 'upsert' | 'delete';
    contentHash: string | null;
    actorUserId: string;
  };
  // ISS-2A — fired from the boot-time builtin seeder when a global skill row
  // is inserted or its content actually changed. Carries no `projectId`
  // because the broadcast targets the cross-tenant `globalRoom()`. The WS
  // bridge maps this to the `skill.updated` wire event with `scope: 'global'`
  // — kept distinct from `skillUpdated` so the override-flow handler does
  // not need a runtime branch on a nullable projectId.
  globalSkillUpdated: {
    name: string;
    oldVersion: number;
    newVersion: number;
    contentHash: string;
  };
  taskCreated: {
    taskId: string;
    issueId: string;
    projectId: string;
    actor: Actor;
  };
  taskUpdated: {
    taskId: string;
    issueId: string;
    projectId: string;
    actor: Actor;
    fields: string[];
  };
  taskDeleted: {
    taskId: string;
    issueId: string;
    projectId: string;
    actor: Actor;
  };
  scheduleRun: {
    scheduleId: string;
    projectId: string;
    // ISS-244 — was `jobId` when schedules rode the jobs/dispatcher path;
    // now points at the agent_sessions row created via the interactive WS
    // entry point.
    sessionId: string;
    actorUserId: string;
  };
  notificationCreated: {
    notificationId: string;
    userId: string;
    projectId: string | null;
    type: string;
    title: string;
    // ISS-510 — body + severity + auto-resolve key carried so the WS bridge can
    // populate a toast (title + body, tone from severity) without a re-read.
    body?: string | null;
    severity?: string | null;
    resolutionKey?: string | null;
    issueId: string | null;
    // ISS-619 — the actionable blocker/child issue for a dependency-stall
    // wedge, distinct from `issueId` (the wedged issue). Carried here so the
    // realtime toast/bridge has parity with the persisted row.
    secondaryIssueId?: string | null;
    agentSessionId: string | null;
    // Epic 5 (ISS-21): set when `type === 'pm_escalation'` so the WS bridge
    // can include it in the project-room broadcast without re-reading the
    // notification body.
    decisionId?: string | null;
  };
  notificationRead: {
    notificationId: string;
    userId: string;
  };
  userPreferencesChanged: {
    userId: string;
    theme: string;
    language: string;
  };
  // ISS-104 — pipeline_run lifecycle. Emitted from the lifecycle helpers in
  // pipeline/runs.ts on every effective status transition (no-op updates on
  // already-terminal rows do not emit). A Sentry-breadcrumb subscriber
  // attaches these to traces so slow-pipeline outliers are inspectable in
  // production.
  pipelineRunStatusChanged: {
    runId: string;
    projectId: string;
    issueId: string | null;
    kind: PipelineRunKind;
    fromStatus: PipelineRunStatus | null;
    toStatus: PipelineRunStatus;
    currentStep: string | null;
    /**
     * ISS-258 — IDs of child jobs the close cascade transitioned out of
     * `queued|dispatched|running`. Empty array when the close was a no-op
     * (already-terminal row) or when the run had no active children.
     */
    cascadedJobIds?: string[];
  };
  // W2.3.2 — monthly budget gate. Fired once per hour per (project, stage)
  // when the dispatcher observes spent ≥ 80% of `perMonthUsd`. Dedup lives
  // in-process; see `jobs/budget-check.ts#shouldEmitWarn`.
  'pipeline.budgetWarning': {
    projectId: string;
    stageStatus: string;
    jobType: JobType;
    spent: number;
    budget: number;
    pct: number;
  };
  // W2.3.2 — fired once per dispatch attempt that the budget gate blocks
  // (action='pause' AND spent ≥ budget). Subscribers (W2.3.4) render
  // Slack/email; the dispatcher also posts an issue comment + fails the job.
  'pipeline.budgetBreach': {
    projectId: string;
    stageStatus: string;
    jobType: JobType;
    spent: number;
    budget: number;
    jobId: string;
    issueId: string | null;
  };
}

export type HookTopic = keyof HookPayloads;
export type HookHandler<T extends HookTopic> = (payload: HookPayloads[T]) => void | Promise<void>;

type AnyHandler = (payload: unknown) => void | Promise<void>;

interface Subscription {
  name: string;
  fn: AnyHandler;
}

export interface HookSubscriberFailure {
  /** Name passed to `on(..., { name })`, or `sub#<registration index>` when anonymous. */
  subscriber: string;
  error: unknown;
}

export interface EmitResult {
  topic: HookTopic;
  /** Subscribers invoked for this emit. */
  delivered: number;
  /** One entry per subscriber that threw. Empty ⇒ every subscriber succeeded. */
  failures: HookSubscriberFailure[];
}

export class HookDeliveryError extends Error {
  readonly topic: HookTopic;
  readonly failures: HookSubscriberFailure[];

  constructor(result: Pick<EmitResult, 'topic' | 'failures'>) {
    const detail = result.failures
      .map(
        (f) => `${f.subscriber}: ${f.error instanceof Error ? f.error.message : String(f.error)}`,
      )
      .join('; ');
    super(`${result.topic}: ${result.failures.length} subscriber(s) failed — ${detail}`);
    this.name = 'HookDeliveryError';
    this.topic = result.topic;
    this.failures = result.failures;
  }
}

/**
 * Throws `HookDeliveryError` when a failure the caller owns is present;
 * no-op otherwise. The bus itself never throws — this lets a specific caller
 * (e.g. `drainOutboxOnce`) opt into treating a subscriber failure as its own.
 *
 * `opts.owned` scopes escalation to failures from the named subscribers only
 * — e.g. `{ owned: ['pipeline-orchestrator'] }` ignores a failing best-effort
 * subscriber that has no local guard (like `pm`) so it never blocks delivery
 * or triggers a wedge meant for "the status change was not processed".
 * Omitting `owned` escalates on any failure.
 */
export function assertHookDelivered(result: EmitResult, opts?: { owned?: string[] }): void {
  const owned = opts?.owned;
  const relevant = owned
    ? result.failures.filter((f) => owned.includes(f.subscriber))
    : result.failures;
  if (relevant.length > 0) {
    throw new HookDeliveryError({ topic: result.topic, failures: relevant });
  }
}

export class HooksBus {
  private readonly handlers = new Map<HookTopic, Set<Subscription>>();

  /**
   * Subscribe to a hook topic. Handlers fire in registration order
   * (deterministic — do not parallelise). `opts.name` identifies this
   * subscriber in `EmitResult.failures` / `pipeline_outbox.last_error`;
   * defaults to the function's own name, falling back to `sub#<index>`.
   */
  on<T extends HookTopic>(topic: T, handler: HookHandler<T>, opts?: { name?: string }): () => void {
    let set = this.handlers.get(topic);
    if (!set) {
      set = new Set();
      this.handlers.set(topic, set);
    }
    const fn = handler as unknown as AnyHandler;
    const name = opts?.name || handler.name || `sub#${set.size}`;
    const entry: Subscription = { name, fn };
    set.add(entry);
    return () => {
      set?.delete(entry);
    };
  }

  // cm:flow dispatch/emit after:outbox — fans the re-emitted transition out to every subscriber; the one that matters here schedules the per-project sweep
  // cm:guard emit MUST NOT throw on a subscriber error — ~48 call sites fire it after their primary mutation already committed; a rethrow here turns a successful write into a 500
  // cm:edge contract -> packages/core/src/pipeline/outbox-worker.ts — drainOutboxOnce keys its processed-vs-failed decision on EmitResult.failures; changing this shape breaks the outbox retry path
  async emit<T extends HookTopic>(topic: T, payload: HookPayloads[T]): Promise<EmitResult> {
    const set = this.handlers.get(topic);
    if (!set || set.size === 0) return { topic, delivered: 0, failures: [] };
    const failures: HookSubscriberFailure[] = [];
    for (const entry of set) {
      try {
        await entry.fn(payload);
      } catch (err) {
        logger.error({ err, topic, subscriber: entry.name }, 'hook subscriber threw — continuing');
        failures.push({ subscriber: entry.name, error: err });
      }
    }
    return { topic, delivered: set.size, failures };
  }

  /** Test-only: drop all handlers. Never call from production code. */
  reset(): void {
    this.handlers.clear();
  }
}

export const hooks = new HooksBus();
