// The lists a release run's kept range reading holds (`shipped-range.ts`), read back whole or not at
// all: the files its range changed, and each commit with its subject and files (ISS-1259).

import type { RangeCommit } from '@forge/contracts/release-page';
import type { RangeChange } from './shipped-range.js';

const CHANGES: ReadonlySet<string> = new Set(['added', 'changed', 'removed']);

/**
 * The files a kept reading says its range changed, or null where it was kept before the files were
 * (or holds one that is not a changed file, which says the same: the list cannot be trusted whole).
 */
export function changedOf(value: unknown): RangeChange[] | null {
  const raw = (value as { changed?: unknown } | null)?.changed;
  if (!Array.isArray(raw)) return null;
  const out: RangeChange[] = [];
  for (const c of raw) {
    const path = (c as { path?: unknown })?.path;
    const change = (c as { change?: unknown })?.change;
    if (typeof path !== 'string' || typeof change !== 'string' || !CHANGES.has(change)) return null;
    out.push({ path, change: change as RangeChange['change'] });
  }
  return out;
}

const WHOLE_COMMIT = /^[0-9a-f]{40}$/;

/**
 * The commits a kept reading names, each with its subject and files, or null where it was kept
 * without them (a runner that predates them) or holds one that is not a commit: the list is whole or
 * not read.
 */
export function commitsOf(value: unknown): RangeCommit[] | null {
  const raw = (value as { commits?: unknown } | null)?.commits;
  if (!Array.isArray(raw)) return null;
  const out: RangeCommit[] = [];
  for (const c of raw) {
    const { sha, subject, paths } = (c ?? {}) as Record<string, unknown>;
    if (typeof sha !== 'string' || !WHOLE_COMMIT.test(sha) || typeof subject !== 'string')
      return null;
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) return null;
    out.push({ sha, subject, paths: paths as string[] });
  }
  return out;
}
