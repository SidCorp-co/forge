// What a knowledge entry's `source` names, and whether this checkout still has it (ISS-1064). The
// anchor audit (`scripts/check-memory-anchors.mjs`) checks these first: a `file:symbol` anchor whose
// file is gone, or whose file no longer holds the symbol, is a dead anchor, and the entry asserts
// something the tree no longer has. An issue or requirement key and a URL are named, never fetched.
// An entry of a kind that owes the three fields and holds none is listed as owing them: the priced
// amnesty `knowledge-entries-without-provenance` in `.forge/conformance.json`.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The kinds that owe `source`, `scope` and `recheckWhen` (`@forge/contracts/knowledge`). */
export const PROVENANCE_KINDS = ['reference', 'guide', 'workflow', 'rule'];
export const PROVENANCE_FIELDS = ['source', 'scope', 'recheckWhen'];

const URL_RE = /^https?:\/\/\S+$/i;
const KEY_RE = /^(?:ISS|REQ|FB|BC|L)-\d+$/;
const PATH_HEAD = /^(?:packages|scripts|docs|drizzle|\.forge|\.github|apps|plugin)\//;
const FILE_EXT = /\.(?:ts|tsx|mjs|js|cjs|rs|sql|json|md|toml|ya?ml|sh)$/;
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/**
 * The anchors a `source` names, in its order: each `path` (and the `symbol` after its colon), each
 * issue or requirement `key` and each `url`. Text that is none of these (a ruling's date, a person)
 * is left out: it is a source, but not one this checkout can check.
 */
export function sourceAnchors(source) {
  if (typeof source !== 'string') return [];
  const out = [];
  for (const raw of source.split(/[\s,;()]+/)) {
    const token = raw.replace(/^[`'"[]+|[`'"\].]+$/g, '');
    if (!token) continue;
    if (URL_RE.test(token)) {
      out.push({ kind: 'url', anchor: token });
      continue;
    }
    if (KEY_RE.test(token)) {
      out.push({ kind: 'key', anchor: token });
      continue;
    }
    const colon = token.indexOf(':');
    const path = colon === -1 ? token : token.slice(0, colon);
    if (!PATH_HEAD.test(path) && !FILE_EXT.test(path)) continue;
    const after = colon === -1 ? '' : token.slice(colon + 1);
    out.push({ kind: 'path', anchor: path, ...(after ? { symbol: after } : {}) });
  }
  return out;
}

/** Whether `p` names a file or directory under `root`, a stem with any extension counting. */
export function pathLiveIn(root, p) {
  for (const base of ['', 'packages/core/', 'packages/web-v2/', 'packages/runner/']) {
    const q = join(root, base + p);
    if (existsSync(q)) return true;
    const slash = q.lastIndexOf('/');
    const dir = q.slice(0, slash);
    const stem = q.slice(slash + 1);
    if (stem && existsSync(dir)) {
      try {
        if (readdirSync(dir).some((f) => f === stem || f.startsWith(`${stem}.`))) return true;
      } catch {}
    }
  }
  return false;
}

/** The file `p` names under `root`, resolved the way `pathLiveIn` finds it, or null. */
function fileIn(root, p) {
  for (const base of ['', 'packages/core/', 'packages/web-v2/', 'packages/runner/']) {
    const q = join(root, base + p);
    try {
      if (statSync(q).isFile()) return q;
    } catch {}
  }
  return null;
}

/**
 * The dead anchors of one entry's `source`, checked against the checkout at `root`: a path that does
 * not exist (`source-path`), a symbol its file does not hold (`source-symbol`), and a line number in
 * place of a symbol (`source-line`), which is stale the moment anything above it moves.
 */
export function deadSourceAnchors(source, root, { ignored = () => false } = {}) {
  const dead = [];
  for (const a of sourceAnchors(source)) {
    if (a.kind !== 'path') continue;
    if (!pathLiveIn(root, a.anchor)) {
      if (!ignored(a.anchor)) dead.push({ kind: 'source-path', anchor: a.anchor });
      continue;
    }
    if (!a.symbol) continue;
    if (/^\d+(?:-\d+)?$/.test(a.symbol)) {
      dead.push({ kind: 'source-line', anchor: `${a.anchor}:${a.symbol}` });
      continue;
    }
    if (!SYMBOL_RE.test(a.symbol)) continue;
    const file = fileIn(root, a.anchor);
    if (!file) continue;
    const held = readFileSync(file, 'utf8');
    const last = a.symbol.split('.').at(-1);
    if (!held.includes(last))
      dead.push({ kind: 'source-symbol', anchor: `${a.anchor}:${a.symbol}` });
  }
  return dead;
}

/** The fields an entry of a kind that owes them leaves out; empty where it owes none or holds all. */
export function owedFields(entry) {
  if (!PROVENANCE_KINDS.includes(entry.kind)) return [];
  return PROVENANCE_FIELDS.filter((f) => typeof entry[f] !== 'string' || entry[f].trim() === '');
}
