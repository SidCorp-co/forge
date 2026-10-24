// What holds delivery back, per issue and per release (REQ-74 BC-4), each hold naming its cause and
// who acts on it next (BC-5). Built from the two read models that already decide these: an issue's
// standing (the release hold at the gate, and who an issue whose run failed waits on now) and each
// run's standing (stuck, behind a gate, a held job, a failed outcome). Nothing here re-derives a
// state; it only picks the rows that are held and says who moves them.

import type {
  OverviewHold,
  OverviewHoldGroup,
  OverviewHoldKind,
  OverviewHolds,
} from '@forge/contracts/development-overview';
import type { IssueStandingRow } from '@forge/contracts/issue-standing';
import type { RunGateWait, RunStanding } from '@forge/contracts/run-standing';
import { type Said, say, sayEn } from '@forge/contracts/said';
import { type WaitingOn, waitingOn } from '@forge/contracts/standing';
import { releaseHoldWords } from '../issues/index.js';
import { failureCause, gateCause, personCause, stuckCause } from './hold-causes.js';

/** A failed run reads as a hold this long after it ended, while nothing has taken its issue up again. */
export const FAILED_HOLD_WINDOW_MS = 24 * 60 * 60_000;

/** The gates a job hold or a retry puts a run behind (`jobs/hold.ts`). */
const JOB_GATES: ReadonlySet<string> = new Set([
  'all_devices_exhausted',
  'verify_unavailable',
  'retry_rounds_exhausted',
  'non_retryable_terminal',
  'retry_cooldown',
]);

const RELEASE_LANES: ReadonlySet<string> = new Set(['release', 'deploy']);

const forge = (act: Said, rule: Said, dueAt: string | null = null): WaitingOn =>
  waitingOn('gate', { who: say('overview.hold.who.forge'), act, rule }, { dueAt });

const master = (rule: Said): WaitingOn =>
  waitingOn('master', {
    who: say('standing.who.master'),
    act: say('overview.hold.act.nextPass'),
    rule,
  });

/** Who clears a gate: the gates no run clears by moving name the person or box that does. */
function gateWho(w: RunGateWait): WaitingOn {
  const rule = w.says.rule;
  if (w.gate === 'runner_stale' || w.gate === 'runner_too_old') {
    return waitingOn('machine', {
      who: say('standing.who.runnerOwner'),
      act:
        w.gate === 'runner_stale'
          ? say('overview.hold.act.reviveRunner')
          : say('overview.hold.act.updateRunner'),
      rule,
    });
  }
  if (w.gate === 'token_cannot_reach') {
    return waitingOn('admins', {
      who: say('standing.who.projectAdmin'),
      act: say('overview.hold.act.grantToken'),
      rule,
    });
  }
  if (w.gate === 'contract_wait_unsettled') {
    return waitingOn('project', {
      who: say('issues.standing.who.contractProvider'),
      act: say('overview.hold.act.settleContract'),
      rule,
    });
  }
  if (w.gate === 'pattern_review_pending') {
    return waitingOn('person', {
      who: say('issues.standing.who.patternReviewer'),
      act: say('overview.hold.act.reviewPattern'),
      rule,
    });
  }
  if (w.gate.startsWith('blocked_on_')) {
    const kind = w.gate.slice('blocked_on_'.length);
    const who =
      kind === 'machine'
        ? say('overview.hold.who.blockerMachine')
        : kind === 'master_or_peer'
          ? say('overview.hold.who.blockerPeer')
          : say('overview.hold.who.blockerOther');
    return waitingOn('gate', { who, act: say('overview.hold.act.clearBlocker'), rule });
  }
  return w.resumesAt
    ? forge(say('overview.hold.act.resumesAt'), rule, w.resumesAt)
    : forge(say('overview.hold.act.resumesWhenClear'), rule);
}

const isGate = (w: RunStanding['waitingOn']): w is RunGateWait => w.kind === 'gate';

/** Which kind of hold a live run is, or null where it is moving or its wait is an ordinary turn. */
function liveKindOf(run: RunStanding): OverviewHoldKind | null {
  const jobHeld = run.job?.status === 'held';
  if (run.state === 'stuck') return 'stuck';
  if (run.state === 'waiting_gate') {
    const w = run.waitingOn;
    if (jobHeld || (isGate(w) && JOB_GATES.has(w.gate))) return 'job';
    return RELEASE_LANES.has(run.lane) ? 'release' : 'blocked';
  }
  if (run.state === 'waiting_person') {
    if (jobHeld) return 'job';
    return RELEASE_LANES.has(run.lane) ? 'release' : null;
  }
  return null;
}

function stuckWho(run: RunStanding): WaitingOn {
  const s = run.stuck;
  if (s.source === 'stuck' && s.failsAt) {
    return forge(say('overview.hold.act.failsAt'), s.says.failsBy, s.failsAt);
  }
  const w = run.waitingOn;
  if (!isGate(w) && w.kind !== 'none') return w;
  return master(s.source === 'stuck' ? s.says.detail : run.says.rule);
}

const issuesOf = (run: RunStanding): string[] =>
  run.issues.length > 0 ? run.issues : run.issue ? [run.issue.key] : [];

function hold(
  kind: OverviewHoldKind,
  run: RunStanding | null,
  fields: Pick<OverviewHold, 'issues' | 'release' | 'waitingOn' | 'since' | 'code'> & {
    cause: Said;
  },
): OverviewHold {
  const { cause, ...rest } = fields;
  return { kind, runId: run?.id ?? null, ...rest, cause: sayEn(cause), says: { cause } };
}

/** The reason a held job's wait names (the run's own rule, `runs.rule.jobHeld`), else null. */
function jobHoldReason(run: RunStanding): string | null {
  const said = run.says.rule;
  const reason = said.key === 'runs.rule.jobHeld' ? said.vars?.reason : undefined;
  return typeof reason === 'string' ? reason : null;
}

/** Why a live run is held, as a plain sentence, and the code it was read from. */
function liveCause(kind: OverviewHoldKind, run: RunStanding): { cause: Said; code: string | null } {
  const w = run.waitingOn;
  if (kind === 'stuck') {
    const s = run.stuck;
    if (s.source !== 'stuck') return { cause: stuckCause(null), code: null };
    return { cause: stuckCause(s.rule), code: s.disagreement ?? s.rule };
  }
  if (isGate(w)) return { cause: gateCause(w.gate), code: w.gate };
  const reason = jobHoldReason(run);
  return reason ? { cause: gateCause(reason), code: reason } : { cause: personCause(), code: null };
}

function liveHold(run: RunStanding): OverviewHold | null {
  const kind = liveKindOf(run);
  if (!kind) return null;
  const w = run.waitingOn;
  const who = kind === 'stuck' ? stuckWho(run) : isGate(w) ? gateWho(w) : w;
  return hold(kind, run, {
    issues: issuesOf(run),
    release: run.release?.version ?? null,
    ...liveCause(kind, run),
    waitingOn: who,
    since: run.since,
  });
}

/**
 * The newest failed run of each issue that nothing has taken up again inside the window: its issue is
 * still open, no live run carries it, and it is not moving. Who acts is who the issue waits on now.
 */
function failedHolds(
  finished: readonly RunStanding[],
  live: readonly RunStanding[],
  rows: ReadonlyMap<string, IssueStandingRow>,
  now: Date,
): OverviewHold[] {
  const carried = new Set(live.flatMap(issuesOf));
  const since = now.getTime() - FAILED_HOLD_WINDOW_MS;
  const seen = new Set<string>();
  const out: OverviewHold[] = [];
  const newestFirst = [...finished].sort((a, b) =>
    (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''),
  );
  for (const run of newestFirst) {
    const o = run.outcome;
    if (o?.kind !== 'failed' || !run.finishedAt) continue;
    if (new Date(run.finishedAt).getTime() < since) continue;
    const keys = issuesOf(run);
    const subject = keys.length > 0 ? keys.join(',') : `${run.lane}:${run.release?.version ?? ''}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    const cause = failureCause(o.cause);
    const code = o.detail ? `${o.cause}: ${o.detail}` : o.cause;
    if (keys.length === 0) {
      out.push(
        hold('failed', run, {
          issues: [],
          release: run.release?.version ?? null,
          cause,
          code,
          waitingOn: master(run.says.rule),
          since: run.finishedAt,
        }),
      );
      continue;
    }
    const open = keys.flatMap((k) => {
      const r = rows.get(k);
      return r && !carried.has(k) && r.standing.attentionGroup !== 'moving' ? [r] : [];
    });
    const first = open[0];
    if (!first) continue;
    out.push(
      hold('failed', run, {
        issues: open.map((r) => r.key),
        release: run.release?.version ?? null,
        cause,
        code,
        waitingOn: first.standing.waitingOn,
        since: run.finishedAt,
      }),
    );
  }
  return out;
}

/** Each issue a release holds at the gate, in the drafted release. */
function releaseHolds(rows: readonly IssueStandingRow[], drafted: string | null): OverviewHold[] {
  return rows.flatMap((r) => {
    const h = r.status === 'awaiting_release' ? r.standing.releaseHold : null;
    if (!h) return [];
    return [
      hold('release', null, {
        issues: [r.key],
        release: drafted,
        cause: releaseHoldWords(h).cause,
        code: h.code,
        waitingOn: r.standing.waitingOn,
        since: h.heldAt,
      }),
    ];
  });
}

function grouped(
  holds: readonly OverviewHold[],
  keysOf: (h: OverviewHold) => string[],
  titleOf: (key: string) => string,
): OverviewHoldGroup[] {
  const groups = new Map<string, OverviewHold[]>();
  for (const h of holds) for (const k of keysOf(h)) groups.set(k, [...(groups.get(k) ?? []), h]);
  return [...groups.entries()]
    .map(([key, list]) => ({ key, title: titleOf(key), holds: list }))
    .sort(
      (a, b) =>
        (a.holds[0]?.since ?? '').localeCompare(b.holds[0]?.since ?? '') ||
        a.key.localeCompare(b.key),
    );
}

export interface HoldFacts {
  /** Open issues' standings. */
  rows: readonly IssueStandingRow[];
  /** Every live run's standing. */
  live: readonly RunStanding[];
  /** Recently finished runs' standings, newest first or not. */
  finished: readonly RunStanding[];
  /** The version the drafted release takes, null where nothing waits at the gate. */
  drafted: string | null;
  now: Date;
}

export function holdsOf(f: HoldFacts): OverviewHolds {
  const byKey = new Map(f.rows.map((r) => [r.key, r]));
  const holds = [
    ...releaseHolds(f.rows, f.drafted),
    ...f.live.flatMap((r) => liveHold(r) ?? []),
    ...failedHolds(f.finished, f.live, byKey, f.now),
  ].sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
  const runTitle = new Map(
    [...f.live, ...f.finished].flatMap((r) => (r.issue ? [[r.issue.key, r.issue.title]] : [])),
  );
  return {
    count: holds.length,
    issues: grouped(
      holds,
      (h) => h.issues,
      (k) => byKey.get(k)?.title ?? runTitle.get(k) ?? k,
    ),
    releases: grouped(
      holds,
      (h) => (h.release ? [h.release] : []),
      (k) => k,
    ),
  };
}
