import type { JudgedBuildIssue, ServedBuild } from '@forge/contracts/verdict-identity';
import { carriageKey } from '../issues/index.js';
import type { JudgedBuildDeps } from './judged-build.js';
import type { KeptRange } from './shipped-range.js';
import type { ShippedReleaseRun } from './shipped-releases.js';

/**
 * Whether `live`, served where a later deploy put it, carries the change at `head` unchanged
 * (ISS-1259): it descends from `head`, and the files the commits it adds change touch none of the
 * files the issue's merge mark names. Read from Forge's own rows, never a host or a box (a read path,
 * ISS-774): descent from the source host's kept answer (`served-ancestry.ts`) or the release record,
 * where both are releases and the later shipped after; the added files from each later release's kept
 * range (`shipped-range.ts:keptRangesOf`), chained from `head` to `live`. What none of these holds is
 * `unread`, named, never guessed.
 */
export async function servedOver(
  issue: JudgedBuildIssue,
  head: string,
  live: string,
  releases: readonly ShippedReleaseRun[],
  environment: string,
  deps: JudgedBuildDeps,
): Promise<ServedBuild> {
  const answer = (carries: ServedBuild['carries'], why: string, touched: string[] = []) => ({
    environment,
    sha: live,
    carries,
    touched,
    why,
  });
  const unread = (why: string) =>
    answer(
      'unread',
      `whether \`${live}\` carries this issue's change unchanged is not read: ${why}`,
    );
  const from = releases.findIndex((r) => r.commit === head);
  const to = releases.findIndex((r) => r.commit === live);
  const kept = deps.heldAncestry
    ? (await deps.heldAncestry(issue.projectId, [head], [live])).get(carriageKey(head, live))
    : undefined;
  if (kept?.kind === 'differs') {
    return answer(
      'not-descendant',
      `\`${live}\` does not descend from \`${head}\`, as the source host answered`,
    );
  }
  if (from >= 0 && to >= 0 && to < from) {
    return answer(
      'not-descendant',
      `\`${live}\` is release ${(releases[to] as ShippedReleaseRun).version}, which shipped before ${(releases[from] as ShippedReleaseRun).version}, so it does not descend from \`${head}\``,
    );
  }
  const descent =
    kept?.kind === 'descends'
      ? 'as the source host answered'
      : from >= 0 && to > from
        ? `release ${(releases[to] as ShippedReleaseRun).version} shipped after ${(releases[from] as ShippedReleaseRun).version} on the release record`
        : null;
  if (descent === null) {
    return unread(
      `${to < 0 ? `\`${live}\` is no release Forge verified` : `\`${head}\` is no release Forge verified`}, and the source host's answer on the pair is not kept, so nothing Forge holds says whether it descends from \`${head}\``,
    );
  }
  if (from < 0 || to < 0) {
    return unread(
      `it descends from \`${head}\` (${descent}), but \`${from < 0 ? head : live}\` is no release Forge verified, so no kept release range names the files its added commits change`,
    );
  }
  const files = [...new Set((issue.mergedPaths?.changes ?? []).map((c) => c.path))];
  if (files.length === 0) {
    return unread(
      "this issue's merge mark names none of the files its landing changed, so none can be weighed",
    );
  }
  const later = releases.slice(from + 1, to + 1);
  const ranges = (await deps.ranges?.(later.map((r) => r.runId))) ?? new Map<string, KeptRange>();
  const changed = new Set<string>();
  let at = head;
  for (const r of later) {
    const range = ranges.get(r.runId);
    if (!range?.changed) {
      return unread(
        `release ${r.version} kept no reading of the files its range changes (\`forge-runner release range\`)`,
      );
    }
    if (range.base.toLowerCase() !== at || range.head.toLowerCase() !== r.commit) {
      return unread(
        `release ${r.version} kept the range \`${range.base.slice(0, 7)}..${range.head.slice(0, 7)}\`, not \`${at.slice(0, 7)}..${r.commit.slice(0, 7)}\``,
      );
    }
    for (const c of range.changed) changed.add(c.path);
    at = r.commit;
  }
  const versions = later.map((r) => r.version).join(', ');
  const touched = files.filter((f) => changed.has(f)).sort();
  if (touched.length > 0) {
    return answer(
      'touched',
      `\`${live}\` descends from \`${head}\` (${descent}), but the commits it adds (${versions}) change ${touched.map((f) => `\`${f}\``).join(', ')}, of this issue's changed files, so it does not carry this issue's change unchanged`,
      touched,
    );
  }
  return answer(
    'unchanged',
    `\`${live}\` descends from \`${head}\` (${descent}), and the commits it adds (${versions}) change none of this issue's ${files.length} changed file${files.length === 1 ? '' : 's'}, so it carries this issue's change unchanged`,
  );
}
