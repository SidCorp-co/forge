// What a release does for each requirement its issues deliver (ISS-463): the codes it moves, and
// whether it completes the requirement, read from the requirement's coverage and its live issues.

import type { ReleaseRequirementView } from '@forge/contracts/releases';
import { type BcVerdict, criteriaCoverageOf, isAgreedStatus } from '@forge/contracts/requirements';

export interface CompletionFacts {
  key: string;
  title: string;
  status: string;
  state: ReleaseRequirementView['state'];
  coverage: readonly {
    code: string;
    verdict: BcVerdict;
    issues: readonly { issueId: string; criterion: number; stale: boolean }[];
  }[];
  live: readonly { id: string; key: string; status: string }[];
}

export function completionOf(
  req: CompletionFacts,
  inRelease: ReadonlySet<string>,
): ReleaseRequirementView {
  const advances = req.coverage
    .filter((c) => c.issues.some((l) => !l.stale && inRelease.has(l.issueId)))
    .map((c) => ({ code: c.code, verdict: c.verdict }));
  const issues = req.live
    .filter((i) => !inRelease.has(i.id) && i.status !== 'closed')
    .map((i) => i.key);
  const criteria = req.coverage.filter((c) => c.verdict !== 'passing').map((c) => c.code);
  const agreed = isAgreedStatus(req.status);
  return {
    key: req.key,
    title: req.title,
    state: req.state,
    completes: agreed && req.coverage.length > 0 && issues.length === 0 && criteria.length === 0,
    advances,
    remaining: { issues, criteria },
    coverage: criteriaCoverageOf(req.coverage),
  };
}
