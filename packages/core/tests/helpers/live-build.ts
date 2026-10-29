/**
 * The live build a requirement's coverage is read against, planted for a test: production serving a
 * commit, and the releases Forge verified, through the real
 * `release-batch/judged-build.ts:liveBuildHolds`. The integration database declares no production
 * probe, so without this every commit or runtime verdict reads as one nobody could check.
 */

import { type JudgedBuildDeps, liveBuildHolds } from '../../src/release-batch/judged-build.js';
import type { ShippedReleaseRun } from '../../src/release-batch/shipped-releases.js';
import {
  provideRequirementDependents,
  requirementDependents,
} from '../../src/requirements/dependents.js';

type Answer = boolean | { unread: string };

/**
 * Production serves `live` (or cannot be read, with `{ why }`). A commit `holds` marks `true` (`false`) is a
 * release Forge verified before (after) the live one — the only way a read path knows a commit is in
 * the live build, since it asks no host and no box. Any other commit gets no answer. Answers the call that
 * puts the booted ports back.
 */
export function plantLiveBuild(
  live: string | { why: string },
  holds: Record<string, Answer> = {},
): () => void {
  const booted = requirementDependents();
  const day = 86_400_000;
  const plant = (entries: [string, Answer][], from: number, version: string) =>
    entries.map(([commit], i) => ({
      runId: `planted-${version}-${i}`,
      version: `0.0.${i}`,
      commit: commit.toLowerCase(),
      issueIds: [],
      cutAt: new Date(from + i * day),
    }));
  const entries = Object.entries(holds);
  const releases: ShippedReleaseRun[] = plant(
    entries.filter(([, a]) => a === true),
    Date.UTC(2026, 0, 1),
    'before',
  );
  if (typeof live === 'string' && !releases.some((r) => r.commit === live.toLowerCase())) {
    releases.push({
      runId: 'planted-live',
      version: '0.0.99',
      commit: live.toLowerCase(),
      issueIds: [],
      cutAt: new Date(Date.UTC(2026, 6, 1)),
    });
  }
  releases.push(
    ...plant(
      entries.filter(([, a]) => a === false),
      Date.UTC(2026, 8, 1),
      'after',
    ),
  );
  const deps: JudgedBuildDeps = {
    served: async () =>
      typeof live === 'string' ? { ok: true, value: live } : { ok: false, why: live.why },
    releases: async () => releases,
    ancestry: async () => ({ kind: 'none', why: 'a read path asks no ancestry reader' }),
    withdrawn: async () => false,
  };
  provideRequirementDependents({
    ...booted,
    liveBuildHolds: (projectId, asked) => liveBuildHolds(projectId, asked, deps),
  });
  return () => provideRequirementDependents(booted);
}
