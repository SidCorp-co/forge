// The project's declared validation gate (`validation.gate`, REQ-71 BC-9, ISS-809): the check its
// changes must pass, read at the commit a release puts on production. Settings showed it as the
// delivery gate and nothing read it, so an on-land release deployed a commit whatever its gate check
// said (Agenfold, 2026-10-30: main at f1bb20e). It is read through the project's source host, never a
// token of ours, and it is no policy gate: `declared_gate` is a kernel rule (`KERNEL_RULES`), so no
// gate profile relaxes it.
//
// One function answers everywhere a commit reaches production: the cut (`create.ts`, and a promotion's
// at its request's head, `promotion-release.ts`) and the release run's deploy (`coolify-commands.ts`),
// which asks again because the head moves between a cut and the agent's deploy. A reading that is not
// a pass is a release blocker of its own code: red is refused, pending waits, a check that never reports
// holds with the wait it has had, a host that will not answer refuses. Nothing here reads a missing
// check as a pass, or a host that did not answer as one.

import type { ProjectedCheckRun } from '../db/schema-repo-projection.js';
import {
  currentHeadRuns,
  type HostCheck,
  resolveSourceHost,
  runPassed,
  type SourceHost,
} from '../integrations/source-host/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import type { ReleaseDeclaration } from './gate.js';
import { blockerRefusal } from './refuse.js';

/** How long after a commit its declared check may take to start reporting before a person owes it. */
export const GATE_REPORT_WINDOW_MINUTES = 30;
const MINUTE_MS = 60_000;

/** What the declared check says at one commit. */
export type GateReading =
  | { state: 'none' }
  | { state: 'pass'; check: string; commit: string }
  | {
      state: 'red';
      check: string;
      commit: string;
      conclusion: string | null;
      url: string | null;
    }
  | {
      state: 'pending';
      check: string;
      commit: string;
      /** `unreported`: no run of the check exists yet, and the commit is within the report window. */
      status: 'queued' | 'running' | 'unreported';
      since: string | null;
    }
  | { state: 'silent'; check: string; commit: string; since: string | null }
  | { state: 'unread'; check: string; where: string; reason: string };

/**
 * Where the commit is read from: the head of a branch, the commit a push put on it (`commit`), or the
 * head of a change request.
 */
export type GateAt =
  | { branch: string; commit?: string }
  | { request: { number: number; headSha: string } };

const earliest = (stamps: readonly (string | null)[]): string | null => {
  const times = stamps.filter((s): s is string => s !== null && !Number.isNaN(Date.parse(s)));
  return times.length === 0
    ? null
    : times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
};

/** The latest run of the named check at `commit`: a re-run replaces the run it re-ran. */
export function gateRunsOf(
  checks: readonly HostCheck[],
  check: string,
  commit: string,
): ProjectedCheckRun[] {
  const sha = commit.toLowerCase();
  const at = checks.map((c) => ({ ...c, headSha: c.headSha.toLowerCase() }));
  return currentHeadRuns(Object.fromEntries(at.map((c) => [c.id, c])), sha).filter(
    (r) => r.name === check,
  );
}

/**
 * What the named check reads at `commit` among the host's `checks`. Red beats pending beats pass: a
 * commit with one red run is refused now, whatever else is still running. No run at all is waited for
 * inside the report window, counted from `committedAt`, and silent after it (or where the host gave no
 * commit time to count from).
 */
export function declaredGateReading(args: {
  check: string;
  commit: string;
  checks: readonly HostCheck[];
  committedAt: string | null;
  now: Date;
}): Exclude<GateReading, { state: 'none' } | { state: 'unread' }> {
  const { check, commit, committedAt, now } = args;
  const runs = gateRunsOf(args.checks, check, commit);
  const failed = runs.find((r) => r.status === 'completed' && !runPassed(r));
  if (failed) {
    return {
      state: 'red',
      check,
      commit,
      conclusion: failed.conclusion,
      url: failed.detailsUrl,
    };
  }
  const open = runs.filter((r) => r.status !== 'completed');
  if (open.length > 0) {
    return {
      state: 'pending',
      check,
      commit,
      status: open.every((r) => r.status === 'queued') ? 'queued' : 'running',
      since: earliest(open.map((r) => r.startedAt)),
    };
  }
  if (runs.length > 0) return { state: 'pass', check, commit };
  const made = committedAt !== null ? Date.parse(committedAt) : Number.NaN;
  if (Number.isNaN(made)) return { state: 'silent', check, commit, since: null };
  const young = now.getTime() - made < GATE_REPORT_WINDOW_MINUTES * MINUTE_MS;
  return young
    ? { state: 'pending', check, commit, status: 'unreported', since: committedAt }
    : { state: 'silent', check, commit, since: committedAt };
}

interface GateDeps {
  host?: () => Promise<SourceHost>;
  now?: () => Date;
}

const whereOf = (at: GateAt): string =>
  'branch' in at
    ? at.commit
      ? `commit ${at.commit.slice(0, 12)} of \`${at.branch}\``
      : `the head of \`${at.branch}\``
    : `the head of change request !${at.request.number}`;

/**
 * Read the declared gate at `at`, or `none` where the project declares none (no host is asked). A
 * host that cannot say what the check reads is `unread` with why, never a pass.
 */
export async function readDeclaredGate(
  projectId: string,
  at: GateAt | null,
  deps: GateDeps = {},
): Promise<GateReading> {
  const gate = (await readProjectDocument(projectId))?.document.validation.gate;
  if (!gate || gate.type === 'none') return { state: 'none' };
  const check = gate.name;
  if (at === null) {
    return {
      state: 'unread',
      check,
      where: 'production',
      reason: 'the project document names no branch production deploys from, so no commit is known',
    };
  }
  try {
    const host = await (deps.host ?? (() => resolveSourceHost(projectId)))();
    const commit = (
      'branch' in at ? (at.commit ?? (await host.branchHead(at.branch))) : at.request.headSha
    ).toLowerCase();
    const checks =
      'branch' in at
        ? await host.readChecks(commit, { named: check })
        : await host.readChangeRequestChecks({
            number: at.request.number,
            headSha: at.request.headSha,
            named: check,
          });
    // the commit's time is asked only where no run of the check exists to count a wait from
    const committedAt =
      gateRunsOf(checks, check, commit).length > 0
        ? null
        : ((await host.readCommit(commit))?.committedAt ?? null);
    return declaredGateReading({
      check,
      commit,
      checks,
      committedAt,
      now: (deps.now ?? (() => new Date()))(),
    });
  } catch (err) {
    return {
      state: 'unread',
      check,
      where: whereOf(at),
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The release blocker a reading stands as, or null where it is a pass or declares nothing. */
export function declaredGateBlocker(reading: GateReading): ReleaseBlocker | null {
  switch (reading.state) {
    case 'none':
    case 'pass':
      return null;
    case 'red':
      return blocker('RELEASE_GATE_CHECK_RED', {
        check: reading.check,
        commit: reading.commit,
        conclusion: reading.conclusion,
        url: reading.url,
      });
    case 'pending':
      return blocker('RELEASE_GATE_CHECK_PENDING', {
        check: reading.check,
        commit: reading.commit,
        status: reading.status,
        since: reading.since,
        windowMinutes: GATE_REPORT_WINDOW_MINUTES,
      });
    case 'silent':
      return blocker('RELEASE_GATE_CHECK_SILENT', {
        check: reading.check,
        commit: reading.commit,
        since: reading.since,
        windowMinutes: GATE_REPORT_WINDOW_MINUTES,
      });
    case 'unread':
      return blocker('RELEASE_GATE_CHECK_UNREAD', {
        check: reading.check,
        where: reading.where,
        reason: reading.reason,
      });
  }
}

/** Refuses by name where the declared gate is not a pass at `at`; returns where it is, or none is declared. */
export async function assertDeclaredGate(
  projectId: string,
  at: GateAt | null,
  deps: GateDeps = {},
): Promise<void> {
  const blocked = declaredGateBlocker(await readDeclaredGate(projectId, at, deps));
  if (blocked) throw blockerRefusal(blocked.code, blocked.details);
}

/** Where the commit a deploying release puts on production is read: the head of the branch it deploys from. */
export function gateAtProduction(
  decl: Extract<ReleaseDeclaration, { kind: 'gated' }>,
): GateAt | null {
  const branch = decl.production.declaration.deploysFrom ?? decl.defaultBranch;
  return branch === null ? null : { branch };
}
