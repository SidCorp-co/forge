import { spawnSync } from 'node:child_process';

/**
 * Whose a combination's refusal is. A refusal naming a path has exactly one owner — the member
 * whose landing last changed it, since an earlier one was green when it was admitted. One naming
 * no path is first a candidate for a single-member defect the entry gate is blind to, and only
 * then an interaction: `docs/modules/landing/verify-window.md` has the order the kinds are settled in.
 */

/** @param {{ landed: { issue: string, landing: string }[], changed: (landing: string) => boolean }} input */
export function ownerOfPath({ landed, changed }) {
  const touching = landed.filter((m) => changed(m.landing));
  if (touching.length === 0) {
    return {
      kind: 'unowned',
      owner: null,
      says: 'no member of this window changed that path, so the refusal is not scoped to one; replay the failing unit',
    };
  }
  const owner = touching.at(-1);
  const earlier = touching.slice(0, -1).map((m) => m.issue);
  const also =
    earlier.length > 0
      ? `; ${earlier.join(', ')} changed it earlier and were green when admitted`
      : '';
  return {
    kind: 'member',
    owner: owner.issue,
    says: `${owner.issue} is the last landing to change that path${also}`,
  };
}

/**
 * @param {{ base: { failed: boolean }, members: { issue: string, failed: boolean }[], window: { failed: boolean } }} replay
 */
export function classifyReplay({ base, members, window }) {
  if (base.failed) {
    return {
      kind: 'pre-existing',
      owner: null,
      says: "it fails on the base alone: it is not this window's, and it does not block the landing on this window's account",
    };
  }
  const failing = members.filter((m) => m.failed).map((m) => m.issue);
  if (failing.length === 1) {
    return {
      kind: 'member',
      owner: failing[0],
      says: `it fails on ${failing[0]} alone, so ${failing[0]} owns it whatever it named`,
    };
  }
  if (failing.length > 1) {
    return {
      kind: 'undetermined',
      owner: null,
      says: `it fails on ${failing.join(', ')} each alone; split the smallest set that could carry it`,
    };
  }
  if (window.failed) {
    return {
      kind: 'interaction',
      owner: null,
      says: 'it fails on no member alone and on the combination: an interaction, which belongs to the window',
    };
  }
  return {
    kind: 'undetermined',
    owner: null,
    says: 'it did not fail on the replay at all, so nothing here reproduces it; say so rather than guess an owner',
  };
}

/** Run `cmd` in `cwd` up to `repeat` times; failed as soon as one run exits non-zero. */
export function replay(cmd, cwd, repeat) {
  for (let i = 1; i <= repeat; i++) {
    const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
      const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
      return { failed: true, runs: i, exit: r.status, tail };
    }
  }
  return { failed: false, runs: repeat, exit: 0, tail: '' };
}
