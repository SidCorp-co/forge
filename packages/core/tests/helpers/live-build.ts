/**
 * The live build a requirement's coverage is read against, planted for a test: production serving a
 * commit, and an ancestry reader answering which commits it holds, through the real
 * `release-batch/judged-build.ts:liveBuildHolds`. The integration database declares no production
 * probe, so without this every commit or runtime verdict reads as one nobody could check.
 */

import { type JudgedBuildDeps, liveBuildHolds } from '../../src/release-batch/judged-build.js';
import type { AncestryReader } from '../../src/release-batch/shipped-earlier-ancestry.js';
import {
  provideRequirementDependents,
  requirementDependents,
} from '../../src/requirements/dependents.js';
import { pairKey } from '../../src/runners/index.js';

type Answer = boolean | { unread: string };

/**
 * Production serves `live` (or cannot be read, with `{ why }`), and the reader answers each commit
 * from `holds` — a commit missing from it gets no answer. Answers the call that puts the booted
 * ports back.
 */
export function plantLiveBuild(
  live: string | { why: string },
  holds: Record<string, Answer> = {},
): () => void {
  const booted = requirementDependents();
  const reader: AncestryReader = {
    async ask(pairs) {
      const out = new Map<string, Answer>();
      for (const p of pairs) {
        const answer = holds[p.commit];
        if (answer !== undefined) out.set(pairKey(p), answer);
      }
      return out;
    },
    witness: () => ({ via: 'source-host' }),
  };
  const deps: JudgedBuildDeps = {
    served: async () =>
      typeof live === 'string' ? { ok: true, value: live } : { ok: false, why: live.why },
    releases: async () => [],
    ancestry: async () => ({ kind: 'box', why: 'planted', reader }),
    withdrawn: async () => false,
  };
  provideRequirementDependents({
    ...booted,
    liveBuildHolds: (projectId, asked) => liveBuildHolds(projectId, asked, deps),
  });
  return () => provideRequirementDependents(booted);
}
