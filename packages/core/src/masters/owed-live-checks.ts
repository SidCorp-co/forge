// The live verdicts a project's latest shipped release owes (ISS-1200): each issue it carries, closed
// by it, whose criteria the release reads open, judged on nothing production serves
// (`release-batch/release-view.ts:proofOf`). It is master work (`masters/owed.ts`), so an outdated
// pane owing only these is replaced rather than drained with nothing placed: drained, the box refuses
// the run declaration the live judge needs. Only the newest shipped release counts, and an issue
// leaves the count once its criteria are judged or moved out, so the count reaches zero.

import type { ReleaseSummary } from '@forge/contracts/releases';
import { guideCall } from '../guides/index.js';
import { agrees } from '../lib/plural.js';
import type { LiveCheckOwed } from './ports.js';

/** Of the newest shipped release, the issues it closed that still wait for their live verdict. Pure. */
export function liveChecksOf(release: ReleaseSummary | null): LiveCheckOwed[] {
  if (release?.state !== 'shipped') return [];
  return release.contents.flatMap((group) =>
    group.issues
      .filter((i) => i.status === 'closed' && i.proof === 'open')
      .map((i) => ({ version: release.version, issueId: i.id, key: i.key })),
  );
}

/** ISS-1200: the live verdicts a shipped release owes, which no run judges unless the master declares one. */
export function liveChecksLine(checks: readonly LiveCheckOwed[]): string {
  if (checks.length === 0) return '';
  const versions = [...new Set(checks.map((c) => c.version))].join(', ');
  const keys = checks.map((c) => `${c.key} ${c.issueId}`).join(', ');
  return ` ${checks.length} issue${agrees(checks.length, '', 's')} the shipped release ${versions} carried ${agrees(checks.length, 'owes its', 'owe their')} live verdict (${keys}): nothing has judged ${agrees(checks.length, 'its', 'their')} criteria on what production serves. Declare a judging run, \`--role qa\`, to judge each criterion there and record its verdict, or move a criterion that cannot be judged there out on the record; \`${guideCall('qa')}\` is how.`;
}
