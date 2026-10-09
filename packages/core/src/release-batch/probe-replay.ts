// The probe replay on each verified deploy (REQ-36 BC-12; issue-delivery r20 `rule-replay`; ISS-470).
//
// Once a release run's deploy is verified against its commit, every kept probe of a criterion that
// passed, on an issue already closed or on the run's own roster, is run against the build it serves
// (`probe-run.ts`), before any claimed issue closes. A probe that holds writes its criterion's
// earned verdict again on the served identity; one that fails writes a fail there naming the release,
// and its issue goes to reopen with the failing probe as the reason, a claimed one instead of
// closing. One that cannot run writes no verdict and counts as no pass: a claimed issue it belongs to
// is not closed. A command probe is not replayed here, and says why.
//
// One replay per run and served commit: the record (`metadata.probeReplay`) is written with the
// verdicts, so a finish resumed after it reads it back and only finishes the moves.

import { randomBytes } from 'node:crypto';
import type { ProbeReplayRecord, ProbeReplayResult } from '@forge/contracts/criterion-probes';
import { eq } from 'drizzle-orm';
import { probeReplayTokenName } from '../credentials/pat-format.js';
import {
  PAT_PERMISSION_GROUPS,
  PAT_PERMISSION_NAMES,
  type PatPermission,
} from '../credentials/pat-permissions.js';
import { mintTurnCredential, turnAuthorityRefusalOf } from '../credentials/turn-credential.js';
import { db, type Tx } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import {
  type ReplayTarget,
  type ReplayVerdict,
  recordReplayVerdicts,
  replayTargetsOf,
  type TransitionActor,
  transitionIssueStatus,
} from '../issues/index.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import { resolveTurnAuthority } from '../permissions/index.js';
import { writeRunMetadata } from '../pipeline/index.js';
import { resolveReleaseDeclaration } from './gate.js';
import {
  type ProbeRun,
  type ReplayCredential,
  type ReplayOrigins,
  runKeptProbe,
} from './probe-run.js';
import { FENCE_LOST } from './refuse.js';
import { releaseClaims } from './releasing-recovery.js';

/** What a replayer's token may reach: every read a project-fenced token may hold, and no write. */
const REPLAY_MENU: readonly PatPermission[] = PAT_PERMISSION_NAMES.filter(
  (name) => name.endsWith(':read') && PAT_PERMISSION_GROUPS[name].reach === 'project',
);
/** Probes run at once; each waits at most its own timeout. */
const REPLAY_CONCURRENCY = 4;
const REPLAY_TOKEN_TTL_MS = 30 * 60 * 1000;
const WHOLE_IDENTITY = /^[0-9a-f]{40,64}$/;

interface ReplayArgs {
  runId: string;
  projectId: string;
  /** The commit the verified deploy serves; null where the verification named none. */
  served: string | null;
  version: string | null;
  actor: TransitionActor;
  fence?: ((tx: Tx) => Promise<void>) | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** The replay a run already recorded, or null. */
export function readProbeReplay(metadata: unknown): ProbeReplayRecord | null {
  const value = (metadata as { probeReplay?: unknown } | null)?.probeReplay;
  return value && typeof value === 'object' ? (value as ProbeReplayRecord) : null;
}

async function recordedReplay(runId: string): Promise<ProbeReplayRecord | null> {
  const [run] = await db
    .select({ metadata: pipelineRuns.metadata })
    .from(pipelineRuns)
    .where(eq(pipelineRuns.id, runId))
    .limit(1);
  return readProbeReplay(run?.metadata);
}

/** The origins this Forge itself answers on: the only ones a replayer's token is ever sent to. */
function ownOrigins(): Set<string> {
  const bases = [env.PUBLIC_API_BASE_URL, env.OAUTH_REDIRECT_BASE, env.APP_BASE_URL];
  return new Set(bases.filter((b): b is string => !!b).map((b) => new URL(b).origin));
}

/** The production environment the deploy serves, or why the replay has none to run against. */
async function originsOf(projectId: string): Promise<ReplayOrigins | string> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (decl?.kind !== 'gated') {
    return 'the project declares no production environment a release deploys, so there is no served build to replay against';
  }
  const { name, declaration } = decl.production;
  return { environment: name, url: declaration.url ?? null, services: declaration.services ?? {} };
}

/**
 * The read-only token a `replayer` request goes out with: minted once, for the release's requester,
 * fenced to the project, and only for this Forge's own origins — a probe of another application is
 * never handed a Forge credential.
 */
function replayerCredential(projectId: string, actor: TransitionActor) {
  const own = ownOrigins();
  let minted: Promise<
    { ok: true; token: string; revoke: () => Promise<void> } | { ok: false; why: string }
  > | null = null;
  const mint = async () => {
    const userId = actor.type === 'user' ? actor.id : actor.ownerId;
    const resolved = await resolveTurnAuthority({ userId, projectId, viaTokenId: null });
    if (!resolved.ok) return { ok: false as const, why: resolved.refusal.message };
    try {
      const turn = await mintTurnCredential({
        authority: resolved.authority,
        menu: REPLAY_MENU,
        name: probeReplayTokenName(new Date(), randomBytes(4).toString('hex')),
        ttlMs: REPLAY_TOKEN_TTL_MS,
      });
      return { ok: true as const, token: turn.token, revoke: turn.revoke };
    } catch (err) {
      const refusal = turnAuthorityRefusalOf(err);
      if (refusal) return { ok: false as const, why: refusal.message };
      throw err;
    }
  };
  const credential: ReplayCredential = async (origin) => {
    if (!own.has(origin)) {
      return {
        ok: false,
        why: `the probe asks for the replayer's credential, and the replayer holds one only for this Forge (${[...own].join(', ')}), not ${origin}`,
      };
    }
    minted ??= mint();
    const held = await minted;
    if (!held.ok) return { ok: false, why: `no replayer credential could be minted: ${held.why}` };
    return { ok: true, authorization: `Bearer ${held.token}` };
  };
  const revoke = async () => {
    const held = minted ? await minted.catch(() => null) : null;
    if (held?.ok) await held.revoke();
  };
  return { credential, revoke };
}

async function runAll(
  targets: readonly ReplayTarget[],
  run: (t: ReplayTarget) => Promise<ProbeRun>,
): Promise<ProbeRun[]> {
  const out: ProbeRun[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const at = next++;
      out[at] = await run(targets[at] as ReplayTarget);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REPLAY_CONCURRENCY, targets.length) }, worker));
  return out;
}

function releaseName(args: ReplayArgs): string {
  return args.version ? `release ${args.version} (run ${args.runId})` : `release run ${args.runId}`;
}

/** The verdict a probe's run writes, or null where it writes none. */
function verdictOf(
  target: ReplayTarget,
  run: ProbeRun,
  args: ReplayArgs & { served: string },
): ReplayVerdict | null {
  if (run.url === null || (run.outcome !== 'held' && run.outcome !== 'failed')) return null;
  const on = `Replayed by ${releaseName(args)} on the served build ${args.served}`;
  const reason =
    run.outcome === 'held'
      ? `${on}: the kept probe held (${run.detail}).${target.standing === 'short' ? ' The shortfall judged before stands.' : ''}`
      : `${on}: the kept probe failed (${run.detail}).`;
  return {
    target,
    verdict: run.outcome === 'held' ? target.standing : 'fail',
    reason,
    served: args.served,
    evidence: run.url,
  };
}

/** Run every probe, then write their verdicts and the record in one fenced transaction. */
async function replay(
  args: ReplayArgs & { served: string },
  origins: ReplayOrigins,
): Promise<ProbeReplayRecord> {
  const targets = await replayTargetsOf(args.projectId, args.runId);
  const { credential, revoke } = replayerCredential(args.projectId, args.actor);
  let runs: ProbeRun[];
  try {
    runs = await runAll(targets, (t) =>
      runKeptProbe(t.probe, { origins, credential, fetchImpl: args.fetchImpl }),
    );
  } finally {
    await revoke();
  }
  return db.transaction(async (tx) => {
    await args.fence?.(tx);
    const drafts = targets.map((t, i) => verdictOf(t, runs[i] as ProbeRun, args));
    const written = await recordReplayVerdicts(
      tx,
      drafts.filter((d): d is ReplayVerdict => d !== null),
      args.actor,
    );
    let w = 0;
    const results: ProbeReplayResult[] = targets.map((t, i) => {
      const run = runs[i] as ProbeRun;
      const base = { issueId: t.issueId, criterion: t.criterion, probeId: t.probeId };
      if (drafts[i] === null)
        return { ...base, outcome: run.outcome, detail: run.detail, verdictId: null };
      const wrote = written[w++];
      if (wrote && 'id' in wrote) {
        return { ...base, outcome: run.outcome, detail: run.detail, verdictId: wrote.id };
      }
      const why = wrote?.refused ?? 'no verdict was written';
      return {
        ...base,
        outcome: 'could_not_run' as const,
        detail: `${run.detail}; its verdict was refused: ${why}`,
        verdictId: null,
      };
    });
    const claimed = new Set(targets.filter((t) => t.claimed).map((t) => t.issueId));
    const reopened = [
      ...new Set(results.filter((r) => r.outcome === 'failed').map((r) => r.issueId)),
    ];
    const held = [
      ...new Set(
        results
          .filter((r) => r.outcome === 'could_not_run' && claimed.has(r.issueId))
          .map((r) => r.issueId),
      ),
    ].filter((id) => !reopened.includes(id));
    const record: ProbeReplayRecord = {
      served: args.served,
      replayedAt: new Date().toISOString(),
      skipped: null,
      results,
      reopened,
      held,
    };
    await writeRunMetadata(args.runId, { merge: { probeReplay: record }, touch: true }, tx);
    return record;
  });
}

async function skip(args: ReplayArgs, why: string): Promise<ProbeReplayRecord> {
  const record: ProbeReplayRecord = {
    served: args.served,
    replayedAt: new Date().toISOString(),
    skipped: why,
    results: [],
    reopened: [],
    held: [],
  };
  await db.transaction(async (tx) => {
    await args.fence?.(tx);
    await writeRunMetadata(args.runId, { merge: { probeReplay: record }, touch: true }, tx);
  });
  return record;
}

/** Why the reopen names its issue's failing probes: each criterion, what it answered, the release. */
function reopenReason(issueId: string, record: ProbeReplayRecord, args: ReplayArgs): string {
  const failed = record.results.filter((r) => r.issueId === issueId && r.outcome === 'failed');
  const lines = failed.map((r) => `criterion ${r.criterion}: ${r.detail}`).join('; ');
  return `A kept probe failed on the build ${releaseName(args)} serves (${record.served}), so this issue is reopened: ${lines}. The fail verdict on each names the release.`;
}

/**
 * Each issue a failing probe sends back: a claimed one from the gate to reopen, its claim released in
 * the same write, and a closed one reopened. A move that does not land keeps a claimed issue held.
 */
async function sendBack(record: ProbeReplayRecord, args: ReplayArgs): Promise<string[]> {
  const notMoved: string[] = [];
  for (const issueId of record.reopened) {
    const [row] = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        status: issues.status,
        reopenCount: issues.reopenCount,
        claim: issues.releaseBatchRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!row || row.status === 'reopen') continue;
    const claimed = row.claim === args.runId;
    if (row.status !== 'closed' && !(claimed && row.status === 'awaiting_release')) continue;
    try {
      await transitionIssueStatus(row, 'reopen', args.actor, {
        transitionReason: reopenReason(issueId, record, args),
        beforeStatusWrite: async (tx) => {
          await args.fence?.(tx);
          if (claimed) await releaseClaims(tx, args.runId, [issueId]);
        },
      });
    } catch (err) {
      if (isRefusal(err, FENCE_LOST)) throw err;
      logger.warn(
        { err, issueId, runId: args.runId },
        'probe-replay: a failing issue was not reopened',
      );
      if (claimed) notMoved.push(issueId);
    }
  }
  return notMoved;
}

export interface ReplayOutcome {
  record: ProbeReplayRecord;
  /** Claimed issues that must not close: sent to reopen, or held because a probe could not run. */
  keepOpen: Map<string, string>;
}

/**
 * Replay the kept probes against what a verified deploy serves, once per run and served commit, and
 * say which claimed issues the close must leave alone.
 */
export async function replayKeptProbes(args: ReplayArgs): Promise<ReplayOutcome> {
  const prior = await recordedReplay(args.runId);
  let record: ProbeReplayRecord;
  if (prior && prior.served === args.served) {
    record = prior;
  } else if (args.served === null || !WHOLE_IDENTITY.test(args.served)) {
    record = await skip(
      args,
      args.served === null
        ? 'the deploy was verified without naming a served commit, so no verdict could name what the probes ran against'
        : `the deploy serves \`${args.served}\`, which is not a whole commit a verdict can name`,
    );
  } else {
    const origins = await originsOf(args.projectId);
    record =
      typeof origins === 'string'
        ? await skip(args, origins)
        : await replay({ ...args, served: args.served }, origins);
  }
  const notMoved = await sendBack(record, args);
  const keepOpen = new Map<string, string>();
  for (const id of record.reopened) {
    keepOpen.set(id, `a kept probe failed on the served build ${record.served}; sent to reopen`);
  }
  for (const id of notMoved) {
    keepOpen.set(
      id,
      `a kept probe failed on the served build ${record.served}, and the move to reopen did not land`,
    );
  }
  for (const id of record.held) {
    const why = record.results
      .filter((r) => r.issueId === id && r.outcome === 'could_not_run')
      .map((r) => `criterion ${r.criterion}: ${r.detail}`)
      .join('; ');
    keepOpen.set(
      id,
      `a kept probe could not run on the served build ${record.served}, which counts as no pass: ${why}`,
    );
  }
  return { record, keepOpen };
}
