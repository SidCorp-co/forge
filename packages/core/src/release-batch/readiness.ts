import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { ReleaseModel, ReleaseStrategy } from '../db/schema.js';
import { projects } from '../db/schema.js';
import { selectAllSlugsFromKnowledge } from '../knowledge/service.js';
import { missingProjectKnowledge } from '../projects/autonomous-contract.js';
import { normalizeEnvironments } from '../projects/environments.js';
import { releaseRunnerLabelOf, resolveReleaseChannels } from './channel.js';
import { resolveReleaseDeclaration } from './gate.js';
import type { ReleaseRollback } from './plan.js';

export type ReleaseGapKey = string;

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
}

export async function loadReleaseReadiness(projectId: string): Promise<ReleaseReadiness | null> {
  const decl = await resolveReleaseDeclaration(projectId);
  if (!decl) return null;

  const [row] = await db
    .select({
      repoPath: projects.repoPath,
      repoUrl: projects.repoUrl,
      releaseModel: projects.releaseModel,
      environments: projects.environments,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const channels = decl.kind === 'gated' ? await resolveReleaseChannels(projectId) : [];
  const declarations = {
    repoPath: row?.repoPath ?? null,
    repoUrl: row?.repoUrl ?? null,
    releaseModel: row?.releaseModel ?? 'none',
  };
  const held = await selectAllSlugsFromKnowledge(projectId);
  const gaps: ReleaseGapKey[] = missingProjectKnowledge(declarations, held).map((o) => o.slug);
  if (decl.kind === 'undeclared-target') gaps.push('release-target');
  let releaseRunnerLabel: string | null = null;
  try {
    releaseRunnerLabel = releaseRunnerLabelOf(projectId, channels);
  } catch {
    gaps.push('release-runner-ambiguous');
  }
  const first = channels[0] ?? null;
  if (decl.kind === 'gated') {
    if (!releaseRunnerLabel && !gaps.includes('release-runner-ambiguous'))
      gaps.push('release-runner');
    if (channels.some((c) => !c.verify)) gaps.push('verify-probes');
    if (normalizeEnvironments(row?.environments).live.commitUrl === null) {
      gaps.push('live-commit-endpoint');
    }
    if (channels.length > 1) gaps.push('release-multi-channel');
    if (channels.some((c) => !c.rollback)) gaps.push('rollback');
    else if (channels.some((c) => c.rollback?.kind === 'unrepresentable'))
      gaps.push('rollback-prose');
  }

  return {
    hasReleaseGate: decl.kind === 'gated',
    releaseModel: decl.kind === 'no-release' ? 'none' : decl.releaseModel,
    releaseStrategy: decl.kind === 'gated' ? decl.releaseStrategy : null,
    baseBranch: decl.kind === 'undeclared-target' ? '' : decl.baseBranch,
    liveBranch: decl.kind === 'gated' ? decl.liveBranch : null,
    targetUndeclared: decl.kind === 'undeclared-target',
    providers: channels.map((c) => c.provider),
    releaseRunnerLabel,
    rollback: first?.rollback && 'text' in first.rollback ? first.rollback.text : null,
    rollbackMode: first?.rollback?.kind ?? null,
    hasVerify: channels.length > 0 && channels.every((c) => c.verify !== null),
    verifySources: channels.map((c) => c.verifySource),
    gaps,
  };
}
