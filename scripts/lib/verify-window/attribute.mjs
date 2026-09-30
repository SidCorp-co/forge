import { spawnSync } from 'node:child_process';

/**
 * Whose a combination's refusal is. A refusal naming a path has exactly one owner — the member
 * whose landing last changed it, since an earlier one was green when it was admitted. One naming
 * no path is first a candidate for a single-member defect the entry gate is blind to, and only
 * then an interaction: `docs/modules/landing/verify-window.md` has the order the kinds are settled in.
 */

/**
 * A path given as a checker prints it — relative to a package, say — matches no landing exactly.
 * Where it ends a path a landing changed, those paths are named and no owner is guessed.
 * @param {{ landed: { issue: string, landing: string }[], path: string,
 *   filesOf: (landing: string) => string[] }} input
 */
export function ownerOfPath({ landed, path, filesOf }) {
  const dir = `${path.replace(/\/+$/, '')}/`;
  const touching = landed.filter((m) =>
    filesOf(m.landing).some((f) => f === path || f.startsWith(dir)),
  );
  if (touching.length === 0) {
    const tail = `/${path.replace(/^\.?\//, '')}`;
    const near = landed.flatMap((m) =>
      filesOf(m.landing)
        .filter((f) => f.endsWith(tail))
        .map((f) => `${m.issue} changed ${f}`),
    );
    if (near.length > 0) {
      return {
        kind: 'unresolved',
        owner: null,
        says: `no landing changed \`${path}\` as given, and it ends a path landings did change (${near.join('; ')}): attribute again with the path from the repository root`,
      };
    }
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
 * A member that could not be rebuilt alone was never replayed, so no owner is named past it.
 * @param {{ base: { failed: boolean }, members: { issue: string, failed: boolean, unbuilt?: string }[],
 *   window: { failed: boolean } }} replay
 */
export function classifyReplay({ base, members, window }) {
  const unran = [
    { where: 'the base', r: base },
    ...members.map((m) => ({ where: `${m.issue} alone`, r: m })),
    { where: 'the combination', r: window },
  ].find((x) => x.r.unran);
  if (unran) {
    return {
      kind: 'undetermined',
      owner: null,
      says: `it could not run on ${unran.where} (${unran.r.unran}), so no replay measured it and no owner is named`,
    };
  }
  const unbuilt = members.find((m) => m.unbuilt);
  if (unbuilt) {
    return {
      kind: 'undetermined',
      owner: null,
      says: `${unbuilt.issue} could not be rebuilt alone (${unbuilt.unbuilt}), so no replay of it ran and no owner is named`,
    };
  }
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

/**
 * The exits that say the command did not run rather than that it failed: a checker's own exit 2,
 * the shell's 126 (not executable) and 127 (not found), and no exit at all (a signal or a spawn error).
 */
const NOT_RUN = new Set([2, 126, 127, null]);

/**
 * Run `cmd` in `cwd` up to `repeat` times; failed as soon as one run exits 1 or any other code
 * a failure reports, `unran` where it exits in a way that says it never measured anything.
 */
export function replay(cmd, cwd, repeat, env = process.env) {
  for (let i = 1; i <= repeat; i++) {
    const r = spawnSync('sh', ['-c', cmd], {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) {
      const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
      const status = r.error ? null : r.status;
      const unran = NOT_RUN.has(status)
        ? status === null
          ? (r.error?.message ?? `killed by ${r.signal}`)
          : `exit ${status}`
        : undefined;
      return { failed: true, runs: i, exit: status, tail, ...(unran ? { unran } : {}) };
    }
  }
  return { failed: false, runs: repeat, exit: 0, tail: '' };
}
