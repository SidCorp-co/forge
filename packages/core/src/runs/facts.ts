import type { KernelIssueStatus, WorkStep } from '@forge/contracts/issue-vocabulary';
import {
  RUN_ISSUE_STATUSES_METADATA_KEY,
  RUN_SESSION_METADATA_TYPE,
} from '../devices/run-session-keys.js';
import { readHoldState } from '../jobs/hold.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import {
  type BaseRun,
  date,
  must,
  type Row,
  readTables,
  seqOf,
  str,
  type Tables,
} from './facts-read.js';
import type { RunFacts } from './standing-types.js';

export { BASE_COLUMNS, type BaseRun, MASTER_RUN_SQL, RUN_SCOPE_SQL } from './facts-read.js';

type Display = (key: string) => string;

function metadataObject(m: unknown): Record<string, unknown> {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

const device = (id: unknown, name: unknown) =>
  id && name !== null && name !== undefined ? { id: String(id), name: String(name) } : null;

function adminOnly(steps: unknown): boolean {
  if (!Array.isArray(steps) || steps.length === 0) return false;
  const last = steps[steps.length - 1] as { options?: Array<{ authority?: string }> };
  const options = Array.isArray(last?.options) ? last.options : [];
  return options.length > 0 && options.every((o) => o.authority === 'admin');
}

// cm:why where each carried issue stood when the run ended: its last kernel transition inside the run's window,
// else the status the run opened it at, which nothing has moved since
function issueStatusesOf(b: BaseRun, t: Tables, keys: string[], display: Display, end: Date) {
  const opening = metadataObject(metadataObject(b.metadata)[RUN_ISSUE_STATUSES_METADATA_KEY]);
  const start = must(b.started_at).getTime();
  const openingStatuses: Record<string, string> = {};
  const endStatuses: Record<string, KernelIssueStatus> = {};
  for (const canonical of keys) {
    const n = seqOf(canonical);
    const row = n === null ? undefined : t.issueBySeq.get(n);
    if (!row) continue;
    const key = display(canonical);
    const opened = str(opening[canonical]);
    if (opened) openingStatuses[key] = opened;
    const moves = t.issueMoves.filter((m) => {
      const at = must(m.created_at).getTime();
      return String(m.entity_id) === String(row.id) && at >= start && at <= end.getTime();
    });
    const last = moves[moves.length - 1];
    if (last) endStatuses[key] = String(last.to_status) as KernelIssueStatus;
    else if (opened) endStatuses[key] = opened as KernelIssueStatus;
  }
  return { openingStatuses, endStatuses };
}

// cm:why the idle-issues sweep's finding on the issue (`pipeline/idle-issues.ts:StrandRecord`); a record that
// names no time or reason is not one this read can stand a stuck rule on
function strandOf(raw: unknown): { at: Date; status: string; reason: string } | null {
  const r = metadataObject(raw);
  const at = str(r.at);
  const reason = str(r.reason);
  if (!at || !reason || Number.isNaN(Date.parse(at))) return null;
  return { at: new Date(at), status: str(r.status) ?? 'unknown', reason };
}

function sessionFacts(s: Row | undefined, lane: string): RunFacts['session'] {
  if (!s || lane !== RUN_SESSION_METADATA_TYPE) return null;
  return {
    id: String(s.id),
    status: String(s.status),
    runtimeState: str(s.runtime_state),
    failureReason: str(s.failure_reason),
    failureDetail: str(s.failure_detail),
    lastHeartbeatAt: date(s.last_heartbeat_at),
    startedAt: date(s.started_at),
    createdAt: must(s.created_at),
    updatedAt: must(s.updated_at),
    device: device(s.device_id, s.device_name),
    name: str(s.name),
  };
}

function jobFacts(j: Row | undefined): RunFacts['job'] {
  if (!j) return null;
  return {
    id: String(j.id),
    type: String(j.type),
    status: String(j.status),
    heldBy: str(j.held_by),
    heldAt: date(j.held_at),
    hold: j.hold ? readHoldState({ __hold: j.hold }) : null,
    retryAfterAt: date(j.retry_after_at),
    failureReason: str(j.failure_reason),
    queuedAt: must(j.queued_at),
    dispatchedAt: date(j.dispatched_at),
    ackedAt: date(j.acked_at),
    finishedAt: date(j.finished_at),
    device: device(j.device_id, j.device_name),
    agentSessionId: str(j.agent_session_id),
    sessionBeat: date(j.session_beat),
    sessionFailureReason: str(j.session_failure_reason),
    sessionFailureDetail: str(j.session_failure_detail),
    sessionStatus: str(j.session_status),
    sessionRuntimeState: str(j.session_runtime_state),
    sessionStartedAt: date(j.session_started_at),
    sessionUpdatedAt: date(j.session_updated_at),
    sessionCreatedAt: date(j.session_created_at),
    sessionHeartbeatReaped: j.session_heartbeat_reaped === true,
    hasEvents: j.job_has_events === true,
  };
}

function questionFacts(
  t: Tables,
  sessionIds: (string | null)[],
  primary: Row | null,
  prefix: string | null,
): RunFacts['question'] {
  const own = sessionIds.filter((id): id is string => id !== null);
  const mine = t.questions.find((x) => {
    const sid = str(x.agent_session_id);
    return sid !== null && own.includes(sid);
  });
  const onIssue = primary
    ? t.questions.find((x) => str(x.issue_id) === String(primary.id))
    : undefined;
  const question = mine ?? onIssue;
  if (!question) return null;
  return {
    id: String(question.id),
    createdAt: must(question.created_at),
    admin: adminOnly(question.steps),
    issueKey:
      primary && str(question.issue_id) === String(primary.id)
        ? formatIssueRef(prefix, Number(primary.iss_seq))
        : null,
  };
}

function masterFacts(t: Tables, masterId: string | null, took: Date) {
  if (!masterId) return { master: null, pass: null };
  const m = t.masterById.get(masterId);
  const pass = t.passes.find(
    (p) =>
      String(p.master_session_id) === masterId &&
      must(p.started_at).getTime() <= took.getTime() &&
      (p.ended_at === null || must(p.ended_at).getTime() >= took.getTime()),
  );
  return {
    master: {
      sessionId: masterId,
      name: m ? str(m.name) : null,
      live: m?.live === true,
      lastBeatAt: m ? date(m.last_beat) : null,
    },
    pass: pass
      ? { id: String(pass.id), verb: String(pass.verb), startedAt: must(pass.started_at) }
      : null,
  };
}

function runPart(b: BaseRun, lane: RunFacts['run']['rawLane'], t: Tables): RunFacts['run'] {
  const phase = t.phases.find((p) => String(p.run_id) === b.id);
  return {
    id: b.id,
    projectId: b.project_id,
    rawLane: lane,
    status: b.status,
    startedAt: must(b.started_at),
    finishedAt: date(b.finished_at),
    updatedAt: must(b.updated_at),
    currentStep: b.current_step,
    openPhase: str(phase?.phase) ?? undefined,
    pauseReason: str(metadataObject(b.metadata).pauseReason),
    releaseVersion: b.release_version,
  };
}

function factsOf(
  b: BaseRun,
  t: Tables,
  prefix: string | null,
  display: Display,
  now: Date,
): RunFacts {
  const { lane, keys } = t.groups.get(b.id) ?? { lane: 'system' as const, keys: [] };
  const s = t.sessionByRun.get(b.id);
  const j = t.jobByRun.get(b.id);
  const primarySeq = b.iss_seq ?? (keys[0] ? seqOf(keys[0]) : null);
  const primary = primarySeq !== null ? (t.issueBySeq.get(primarySeq) ?? null) : null;
  const sessionFlip = s ? (t.sessionFlips.get(String(s.id)) ?? null) : null;
  const end = date(b.finished_at) ?? sessionFlip?.at ?? now;
  const ledger = s ? t.ledgerBySession.get(String(s.id)) : undefined;
  const masterId = (s ? str(s.parent_session_id) : null) ?? (j ? str(j.held_by) : null);
  const took = (j ? date(j.held_at) : null) ?? must(b.started_at);
  const approval = t.approvals.find((a) => String(a.run_id) === b.id);
  const release = t.releases.find((r) => String(r.run_id) === b.id);
  const attempt = t.attempts.get(b.id);
  const live = t.liveness.get(b.id);
  return {
    run: runPart(b, lane, t),
    issue: primary
      ? {
          id: String(primary.id),
          key: formatIssueRef(prefix, Number(primary.iss_seq)),
          title: String(primary.title),
          status: primary.status as KernelIssueStatus,
          statusSince: date(primary.status_since),
          strand: strandOf(primary.strand),
        }
      : null,
    issues: keys.map(display),
    ...issueStatusesOf(b, t, keys, display, end),
    workState: primary
      ? {
          step: (str(primary.step) as WorkStep | null) ?? null,
          stepStartedAt: date(primary.step_started_at),
          lease: primary.lease ?? null,
        }
      : null,
    session: sessionFacts(s, lane),
    job: jobFacts(j),
    liveJobs: live?.liveJobs ?? 0,
    lastBeatAt: date(live?.beat ?? null),
    ledger: ledger
      ? {
          incarnation: String(ledger.incarnation),
          work: String(ledger.work),
          blockerKind: str(ledger.blocker_kind),
          waitingOn: str(ledger.waiting_on),
          observedAt: must(ledger.observed_at),
        }
      : null,
    fleetKeys: t.leases
      .filter((k) => String(k.run_id) === b.id)
      .map((k) => ({
        issueKey: display(String(k.issue_key)),
        sessionId: String(k.session_id),
        acquiredAt: must(k.acquired_at),
      })),
    deployLocks: t.locks
      .filter((l) => String(l.run_id) === b.id)
      .map((l) => ({
        environment: String(l.environment),
        subject: String(l.subject),
        acquiredAt: must(l.acquired_at),
        expiresAt: must(l.expires_at),
        reclaimedFromRunId: str(l.reclaimed_from_run_id),
        held: true,
      })),
    question: questionFacts(
      t,
      [s ? String(s.id) : null, j ? str(j.agent_session_id) : null],
      primary,
      prefix,
    ),
    approval: approval
      ? { id: String(approval.id), requestedAt: must(approval.requested_at) }
      : null,
    releaseAttempt: release
      ? {
          stage: String(release.stage),
          verdict: str(release.verdict),
          startedAt: must(release.started_at),
        }
      : null,
    runFlip: t.runFlips.get(b.id) ?? null,
    sessionFlip,
    ...masterFacts(t, masterId, took),
    attempt: attempt
      ? { n: attempt.n, retryOf: attempt.retryOf, of: display(attempt.workKey) }
      : null,
  };
}

export async function gatherFacts(prefix: string | null, base: BaseRun[]): Promise<RunFacts[]> {
  if (base.length === 0) return [];
  const projectId = base[0]?.project_id as string;
  const t = await readTables(projectId, base);
  const display: Display = (key) => {
    const n = seqOf(key);
    return n === null ? key : formatIssueRef(prefix, n);
  };
  const now = new Date();
  return base.map((b) => factsOf(b, t, prefix, display, now));
}
