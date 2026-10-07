import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { ReleaseCrossing } from '../db/schema.js';
import { projects } from '../db/schema.js';
import { selectAllSlugsFromKnowledge } from '../knowledge/service.js';
import { missingProjectKnowledge } from '../projects/autonomous-contract.js';
import { normalizeEnvironments } from '../projects/environments.js';
import { type ReleaseChain, retiredReleaseAxes } from '../projects/release-chain.js';
import {
  collectReleaseBlockers,
  type ReleaseBlocker,
  type ReleaseWarning,
  releaseBlockerSentence,
} from './blockers.js';
import { type CarriedRecord, carriedRecord, readCarried } from './carried.js';
import { releaseRunnerLabelOf } from './channel.js';
import type { ReleaseRollback, VerifySource } from './plan.js';
import { readWeighingNow } from './runtime-weighing.js';
import { readServingNow } from './serving-reading.js';

export type ReleaseGapKey = string;

type ReleaseDeclarationRead = Awaited<ReturnType<typeof collectReleaseBlockers>>['declaration'];
type ReleaseChannelRead = NonNullable<
  Awaited<ReturnType<typeof collectReleaseBlockers>>['channels']
>[number];
interface ProjectRow {
  repoPath: string | null;
  repoUrl: string | null;
  releaseChain: ReleaseChain;
  environments: unknown;
}

export interface ReleaseReadiness {
  hasReleaseGate: boolean;
  /** The ordered release path. Empty means this project ships nothing. */
  releaseChain: ReleaseChain;
  /** ISS-1311 — derived from `releaseChain` for `forge-plugin`; see `retiredReleaseAxes`. */
  releaseModel: 'none' | 'promote' | 'publish';
  releaseStrategy: ReleaseCrossing | null;
  baseBranch: string;
  /** Non-null only where the chain has two or more entries. */
  liveBranch: string | null;
  targetUndeclared: boolean;
  /** Providers of every live deploy binding. Empty when the project declares none. */
  providers: string[];
  releaseRunnerLabel: string | null;
  /** Verbatim rollback declaration; `null` when the channel performs it or none is declared. */
  rollback: string | null;
  /** How the declaration was read. `null` means abort-and-comment on failure. */
  rollbackMode: ReleaseRollback['kind'] | null;
  hasVerify: boolean;
  /** Where each live channel's probes came from, in the same order as `providers`. */
  verifySources: VerifySource[];
  /** False where the declaration could not be READ: the chain is then a fallback, not a reading. */
  declarationRead: boolean;
  /** The same, for `providers`, the rollback, `hasVerify` and the label. */
  channelsRead: boolean;
  /** Everything still undeclared. Empty means settings has nothing to say. */
  gaps: ReleaseGapKey[];
  /**
   * Every reason a release would be refused RIGHT NOW, in the order the create
   * door refuses in — the declarations, and also the roster and the fleet, which
   * `gaps` never looked at. Empty here means a create over this roster succeeds;
   * that equivalence is the whole of ISS-1127.
   */
  blockers: ReleaseBlocker[];
  /** What will change how the release runs without stopping it. */
  warnings: ReleaseWarning[];
  /**
   * What a release cut now would carry beyond its roster, or why that range was not read
   * (`not-read`, `unbound`, `unread`, each with its `why`) — the same reading the create door
   * judges (ISS-1386).
   */
  carried: CarriedRecord | null;
}

export async function loadReleaseReadiness(projectId: string): Promise<ReleaseReadiness | null> {
  // ONE pass: the enumerator guards these reads and a second copy would throw away its report
  // (ISS-1127). The reading is HERE because the enumerator reaches no network (ISS-1286).
  const serving = await readServingNow(projectId).catch(() => undefined);
  const weighing = serving
    ? await readWeighingNow(projectId, serving).catch((err: unknown) =>
        err instanceof Error ? err.message : String(err),
      )
    : undefined;
  const carried = await readCarried(projectId, []);
  const report = await collectReleaseBlockers(projectId, { serving, weighing, carried });
  if (!report.projectExists) return null;
  const decl = report.declaration;
  const channels = report.channels ?? [];
  const blockers = [...report.blockers];

  const row = await guarded('project', blockers, async () => {
    const [found] = await db
      .select({
        repoPath: projects.repoPath,
        repoUrl: projects.repoUrl,
        releaseChain: projects.releaseChain,
        environments: projects.environments,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return found ?? null;
  });
  const held = await guarded('knowledge', blockers, () => selectAllSlugsFromKnowledge(projectId));

  const gaps = declarationGaps({ decl, channels: report.channels, row, held });
  const first = channels[0] ?? null;
  let releaseRunnerLabel: string | null = null;
  try {
    releaseRunnerLabel = releaseRunnerLabelOf(projectId, channels);
  } catch {
    releaseRunnerLabel = null;
  }

  return {
    declarationRead: decl !== null,
    channelsRead: report.channels !== null,
    hasReleaseGate: decl?.kind === 'gated',
    releaseChain: decl?.releaseChain ?? [],
    ...retiredReleaseAxes(decl?.releaseChain ?? []),
    baseBranch: !decl || decl.kind === 'undeclared-target' ? '' : decl.baseBranch,
    targetUndeclared: decl?.kind === 'undeclared-target',
    providers: channels.map((c) => c.provider),
    releaseRunnerLabel,
    rollback: first?.rollback && 'text' in first.rollback ? first.rollback.text : null,
    rollbackMode: first?.rollback?.kind ?? null,
    hasVerify: channels.length > 0 && channels.every((c) => c.verify !== null),
    verifySources: channels.map((c) => c.verifySource),
    gaps,
    blockers,
    warnings: report.warnings,
    carried: carriedRecord(report.carried),
  };
}

/** A read this answer needs, and the blocker that stands in for it when it fails. */
async function guarded<T>(
  check: string,
  out: ReleaseBlocker[],
  read: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    out.push({
      code: 'RELEASE_CHECK_UNEVALUATED',
      httpStatus: 503,
      message: releaseBlockerSentence('RELEASE_CHECK_UNEVALUATED', { check, detail }),
      details: { check, detail },
      evaluated: false,
    });
    return undefined;
  }
}

/** In every field, the unset value means the read FAILED — never an absence. */
interface GapInput {
  decl: ReleaseDeclarationRead;
  channels: ReleaseChannelRead[] | null;
  row: ProjectRow | null | undefined;
  held: string[] | undefined;
}

/** What settings still has to say. Unchanged by ISS-1127, and still not the blocker list. */
function declarationGaps(input: GapInput): ReleaseGapKey[] {
  const { decl, channels, row, held } = input;
  const gaps: ReleaseGapKey[] = [];
  // A gap is an ABSENCE somebody can act on, never a read nobody managed to
  // make (ISS-1127).
  if (row !== undefined && held !== undefined) {
    const declarations = {
      repoPath: row?.repoPath ?? null,
      repoUrl: row?.repoUrl ?? null,
      releaseChain: row?.releaseChain ?? [],
    };
    gaps.push(...missingProjectKnowledge(declarations, held).map((o) => o.slug));
  }
  if (decl?.kind === 'undeclared-target') gaps.push('release-target');
  if (decl?.kind !== 'gated') return gaps;

  if (row !== undefined && normalizeEnvironments(row?.environments).live.commitUrl === null) {
    gaps.push('live-commit-endpoint');
  }
  if (channels === null) return gaps;

  const labels = [...new Set(channels.map((c) => c.releaseRunnerLabel).filter((l) => l !== null))];
  if (labels.length > 1) gaps.push('release-runner-ambiguous');
  if (channels.some((c) => !c.verify)) gaps.push('verify-probes');
  if (channels.length > 1) gaps.push('release-multi-channel');
  if (channels.some((c) => !c.rollback)) gaps.push('rollback');
  else if (channels.some((c) => c.rollback?.kind === 'unrepresentable'))
    gaps.push('rollback-prose');
  return gaps;
}
