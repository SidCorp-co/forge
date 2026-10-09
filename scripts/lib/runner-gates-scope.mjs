import { baseRef } from './base-branch.mjs';
import { gitOut } from './gate.mjs';

/**
 * The runner files `check-runner-gates.mjs` measures: what HEAD changed under `packages/runner`
 * since its merge-base with the merge target, plus what the working tree holds uncommitted. On a
 * landing already on its base, `FORGE_LANDED_SINCE` makes that base the landing's own (ISS-472
 * round 3), where the target's tip would be HEAD and the scope empty.
 *
 * @returns {{ files: Set<string> } | { noGit: true } | { refusal: string }}
 */
export function crateScope(root, env = process.env) {
  if (gitOut(['rev-parse', '--git-dir'], root) === null) return { noGit: true };
  const target = baseRef(root, env);
  if (target.refusal) return { refusal: target.refusal };
  const base = gitOut(['merge-base', target.ref, 'HEAD'], root)?.trim();
  if (!base) {
    return {
      refusal:
        `\`git merge-base ${target.ref} HEAD\` did not answer, so the changed set cannot be scoped —\n` +
        `run \`git fetch origin ${target.branch}\`, or pass --all to run every gate unconditionally.`,
    };
  }
  const files = new Set();
  const diffed = gitOut(['diff', '--name-only', base, '--', 'packages/runner'], root) ?? '';
  for (const l of diffed.split('\n')) {
    if (l.trim()) files.add(l.trim());
  }
  for (const l of (gitOut(['status', '--porcelain', '--', 'packages/runner'], root) ?? '').split(
    '\n',
  )) {
    const p = l.slice(3).trim();
    if (p) files.add(p);
  }
  return { files };
}
