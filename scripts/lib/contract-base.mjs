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

/** The committed file naming what the interface registry already holds for each artifact. */
export const FLOOR_PATH = 'packages/core/contracts/registry-floor.json';

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const COMMIT = /^[0-9a-f]{40}$/;
const FLOOR_SHAPE =
  '{ "<artifact file>": { "contract": "<registry slug>", "version": "MAJOR.MINOR.PATCH", "source": "<40-hex commit it was uploaded from>" } }';

function floorFault(file, entry) {
  if (!(file in CONTRACT_PATHS)) {
    return `"${file}" is not a published artifact; the artifacts are ${Object.keys(CONTRACT_PATHS).join(', ')}`;
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `"${file}" is not an object`;
  }
  const extra = Object.keys(entry).filter((k) => !['contract', 'version', 'source'].includes(k));
  if (extra.length > 0) return `"${file}" carries unknown key(s) ${extra.join(', ')}`;
  if (typeof entry.contract !== 'string' || entry.contract.length === 0) {
    return `"${file}".contract names no registry contract`;
  }
  if (typeof entry.version !== 'string' || !SEMVER.test(entry.version)) {
    return `"${file}".version ${JSON.stringify(entry.version)} is not MAJOR.MINOR.PATCH`;
  }
  if (typeof entry.source !== 'string' || !COMMIT.test(entry.source)) {
    return `"${file}".source ${JSON.stringify(entry.source)} is not a 40-hex commit`;
  }
  return null;
}

/**
 * The registry floor for each artifact: the latest number the interface registry holds, approved
 * or not, and the artifact's text at the commit it was uploaded from, which the registry measures
 * the next upload against. An artifact the file does not name has no floor; an entry that is
 * malformed, or whose commit holds no such artifact here, is refused by name.
 *
 * @returns {{ floors: Record<string, { contract: string, version: string, source: string, text: string } | null> } | { refusal: string }}
 */
export function registryFloor(root, readText) {
  const floors = Object.fromEntries(Object.keys(CONTRACT_PATHS).map((f) => [f, null]));
  const raw = readText(FLOOR_PATH);
  if (raw === null) return { floors };
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { refusal: `${FLOOR_PATH} is not JSON (${err.message})` };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { refusal: `${FLOOR_PATH} is ${FLOOR_SHAPE}` };
  }
  for (const [file, entry] of Object.entries(doc)) {
    if (file === '$comment') continue;
    const fault = floorFault(file, entry);
    if (fault) return { refusal: `${FLOOR_PATH}: ${fault}; the file is ${FLOOR_SHAPE}` };
    const text = contractsAt(root, entry.source)[file];
    if (text === null) {
      return {
        refusal:
          `${FLOOR_PATH}: "${file}" names ${entry.source.slice(0, 12)}, which holds no ` +
          `${CONTRACT_PATHS[file]} here, so the text the registry measures against cannot be read. ` +
          'Fetch the history (`fetch-depth: 0`) or name the commit the version was uploaded from',
      };
    }
    floors[file] = { ...entry, text };
  }
  return { floors };
}
