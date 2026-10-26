// The revision whose committed contracts a generated contract is numbered after. The generator
// derives each artifact's version from the one this revision holds, so the number moves only when
// the contract moves against the branch the change lands on, however often a branch regenerates.

import { execFileSync } from 'node:child_process';
import { baseRef } from './base-branch.mjs';
import { pushedFrom } from './baseline-ratchet.mjs';

/** Where the two artifacts sit in the tree, as `git show <rev>:<path>` names them. */
export const CONTRACT_PATHS = {
  'forge-api.openapi.json': 'packages/core/contracts/forge-api.openapi.json',
  'forge-mcp.tools.json': 'packages/core/contracts/forge-mcp.tools.json',
};

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * The merge-base with the merge target; on that target's own tip, the commit a push moved it
 * from; and on the tip outside a push, HEAD itself, whose committed contracts already carry the
 * number they landed with. Not `HEAD~1` as a baseline gate takes it: a tree edited on the tip is
 * numbered after what the tip holds, never after the commit before it.
 *
 * @returns {{ rev: string, basis: string } | { refusal: string }}
 */
export function contractBase(root, env = process.env) {
  const target = baseRef(root, env);
  if (target.refusal) return { refusal: target.refusal };
  let head;
  let mb;
  try {
    head = git(['rev-parse', 'HEAD'], root);
    mb = git(['merge-base', target.ref, 'HEAD'], root);
  } catch {
    return {
      refusal:
        `\`git merge-base ${target.ref} HEAD\` found no common ancestor, so no committed contract ` +
        `can number this one. Fetch the history: \`git fetch origin ${target.branch}\`, or check ` +
        'out with `fetch-depth: 0`',
    };
  }
  if (mb !== head) return { rev: mb, basis: `the merge-base with ${target.branch}` };
  try {
    const pushed = pushedFrom(root, env, head);
    if (pushed) return { rev: pushed, basis: `the commit this push moved ${target.branch} from` };
  } catch (err) {
    return { refusal: err.message };
  }
  return { rev: head, basis: `HEAD, the tip of ${target.branch}` };
}

/** Each artifact's text at `rev`, null where that revision holds none. */
export function contractsAt(root, rev) {
  const out = {};
  for (const [file, path] of Object.entries(CONTRACT_PATHS)) {
    try {
      out[file] = `${git(['show', `${rev}:${path}`], root)}\n`;
    } catch {
      out[file] = null;
    }
  }
  return out;
}
