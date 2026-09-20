import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { ReleaseModel, ReleaseStrategy } from '../db/schema.js';
import { projects } from '../db/schema.js';
import { selectAllSlugsFromKnowledge } from '../knowledge/service.js';
import { missingProjectKnowledge } from '../projects/autonomous-contract.js';
import { normalizeEnvironments } from '../projects/environments.js';
import {
  collectReleaseBlockers,
  type ReleaseBlocker,
  type ReleaseWarning,
  releaseBlockerSentence,
} from './blockers.js';
import { releaseRunnerLabelOf } from './channel.js';
import type { ReleaseRollback } from './plan.js';

export type ReleaseGapKey = string;

type ReleaseDeclarationRead = Awaited<ReturnType<typeof collectReleaseBlockers>>['declaration'];
type ReleaseChannelRead = NonNullable<
  Awaited<ReturnType<typeof collectReleaseBlockers>>['channels']
>[number];
interface ProjectRow {
  repoPath: string | null;
  repoUrl: string | null;
  releaseModel: ReleaseModel;
  environments: unknown;
}

export interface ReleaseReadiness {
  hasReleaseGate: boolean;
  releaseModel: ReleaseModel;
  releaseStrategy: ReleaseStrategy | null;
  baseBranch: string;
  /** Non-null only under `promote`. */
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
  verifySources: Array<'binding' | 'environments-live' | 'none'>;
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
}

export async function loadReleaseReadiness(projectId: string): Promise<ReleaseReadiness | null> {
  // ONE pass. Reading the declaration and the channels a second time here is
  // what made this answer 500 on an unreadable binding: the enumerator already
  // guards those reads, and a second unguarded copy would throw away the report
  // it just produced (ISS-1127).
  const report = await collectReleaseBlockers(projectId);
  if (!report.projectExists) return null;
  const decl = report.declaration;
  const channels = report.channels ?? [];
  const blockers = [...report.blockers];

  const row = await guarded('project', blockers, async () => {
    const [found] = await db
      .select({
        repoPath: projects.repoPath,
        repoUrl: projects.repoUrl,
        releaseModel: projects.releaseModel,
        environments: projects.environments,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    return found ?? null;
  });
  const held = await guarded('knowledge', blockers, () => selectAllSlugsFromKnowledge(projectId));

  const gaps = declarationGaps({ decl, channels, row: row ?? null, held: held ?? [] });
  const first = channels[0] ?? null;
  let releaseRunnerLabel: string | null = null;
  try {
    releaseRunnerLabel = releaseRunnerLabelOf(projectId, channels);
  } catch {
    releaseRunnerLabel = null;
  }

  return {
    hasReleaseGate: decl?.kind === 'gated',
    releaseModel: !decl || decl.kind === 'no-release' ? 'none' : decl.releaseModel,
    releaseStrategy: decl?.kind === 'gated' ? decl.releaseStrategy : null,
    baseBranch: !decl || decl.kind === 'undeclared-target' ? '' : decl.baseBranch,
    liveBranch: decl?.kind === 'gated' ? decl.liveBranch : null,
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

interface GapInput {
  decl: ReleaseDeclarationRead;
  channels: ReleaseChannelRead[];
  row: ProjectRow | null;
  held: string[];
}

/** What settings still has to say. Unchanged by ISS-1127, and still not the blocker list. */
function declarationGaps(input: GapInput): ReleaseGapKey[] {
  const { decl, channels, row, held } = input;
  const declarations = {
    repoPath: row?.repoPath ?? null,
    repoUrl: row?.repoUrl ?? null,
    releaseModel: row?.releaseModel ?? 'none',
  };
  const gaps: ReleaseGapKey[] = missingProjectKnowledge(declarations, held).map((o) => o.slug);
  if (decl?.kind === 'undeclared-target') gaps.push('release-target');
  if (decl?.kind !== 'gated') return gaps;

  const labels = [...new Set(channels.map((c) => c.releaseRunnerLabel).filter((l) => l !== null))];
  if (labels.length > 1) gaps.push('release-runner-ambiguous');
  else if (labels.length === 0) gaps.push('release-runner');
  if (channels.some((c) => !c.verify)) gaps.push('verify-probes');
  if (normalizeEnvironments(row?.environments).live.commitUrl === null) {
    gaps.push('live-commit-endpoint');
  }
  if (channels.length > 1) gaps.push('release-multi-channel');
  if (channels.some((c) => !c.rollback)) gaps.push('rollback');
  else if (channels.some((c) => c.rollback?.kind === 'unrepresentable'))
    gaps.push('rollback-prose');
  return gaps;
}
