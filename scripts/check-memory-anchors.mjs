#!/usr/bin/env node

// Audits the Forge cloud memory + knowledge stores against THIS checkout: every
// repo path, every backticked identifier and every [[link]] a row cites must
// resolve, or the row is asserting something the tree no longer has.
//
// A knowledge entry's `source` is checked first (ISS-1064, `lib/knowledge-anchors.mjs`): a path it
// names that is gone, or a symbol its file no longer holds, is a dead anchor. An entry of a kind
// owing `source`, `scope` and `recheckWhen` that leaves one out is listed as owing them, the priced
// amnesty `knowledge-entries-without-provenance` (`.forge/conformance.json`); it fails nothing.
//
// Exit 0 clean · 1 dead anchors · 2 the check could not run.
//
// Usage:  node scripts/check-memory-anchors.mjs --project <uuid> [--json]
//         node scripts/check-memory-anchors.mjs --entries <file> [--json]
//         --entries reads the knowledge entries from a JSON array (as GET .../knowledge/<slug>
//         answers each) instead of the store, and reads no memory and no host.
// Host and token: $FORGE_API with $FORGE_PAT, else the `url` and `token` of the
// forge CLI's config.json ($XDG_CONFIG_HOME/forge, else ~/.config/forge). Both
// come from one place, so a token is never sent to another instance's host.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { dieAs } from './lib/gate.mjs';
import { deadSourceAnchors, owedFields } from './lib/knowledge-anchors.mjs';

const die = dieAs('check-memory-anchors');

const ENTRIES_AT = process.argv.indexOf('--entries');
const ENTRIES_FILE = ENTRIES_AT === -1 ? null : process.argv[ENTRIES_AT + 1];
if (ENTRIES_AT !== -1 && (!ENTRIES_FILE || ENTRIES_FILE.startsWith('--')))
  die('--entries needs the path of a JSON array of knowledge entries');
const PROJECT = ENTRIES_FILE
  ? null
  : (process.argv[process.argv.indexOf('--project') + 1]?.match(/^[0-9a-f-]{36}$/)?.[0] ??
    die('--project <uuid> is required: the project whose memory and knowledge rows are audited'));
const JSON_OUT = process.argv.includes('--json');

function target() {
  if (process.env.FORGE_PAT || process.env.FORGE_API) {
    if (!process.env.FORGE_PAT || !process.env.FORGE_API)
      die('$FORGE_PAT and $FORGE_API are set together or not at all: a token alone names no host');
    return { api: process.env.FORGE_API, token: process.env.FORGE_PAT };
  }
  const dir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const p = join(dir, 'forge/config.json');
  if (!existsSync(p)) die(`no $FORGE_PAT/$FORGE_API and no ${p}`);
  const { url, token } = JSON.parse(readFileSync(p, 'utf8'));
  if (!url || !token) die(`${p} carries no ${url ? 'token' : 'url'}`);
  return { api: url.replace(/\/+$/, ''), token };
}
let TARGET = null;

async function get(path) {
  TARGET ??= target();
  const res = await fetch(`${TARGET.api}${path}`, {
    headers: { Authorization: `Bearer ${TARGET.token}`, 'User-Agent': 'curl/8.5.0' },
  });
  if (!res.ok) die(`${path} -> HTTP ${res.status}`);
  return res.json();
}

const CODE = new Set(['.ts', '.tsx', '.mjs', '.js', '.rs']);
const TEXT = new Set(['.sql', '.json', '.md', '.toml', '.yml', '.yaml']);
const SKIP = /node_modules|[/\\]\.next|[/\\]dist|[/\\]target|[/\\]coverage|[/\\]\.git/;

function buildCorpus(roots) {
  const out = [];
  const walk = (dir) => {
    if (SKIP.test(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const ext = extname(e.name);
        if (!CODE.has(ext) && !TEXT.has(ext)) continue;
        let s;
        try {
          s = readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        if (CODE.has(ext)) {
          s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        }
        out.push(s);
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  return out.join('\n');
}

let ignoredCache = null;
function gitIgnored(p) {
  if (ignoredCache === null) ignoredCache = new Map();
  if (ignoredCache.has(p)) return ignoredCache.get(p);
  let r = false;
  try {
    execFileSync('git', ['check-ignore', '-q', '--', p], { stdio: 'ignore' });
    r = true;
  } catch {}
  ignoredCache.set(p, r);
  return r;
}

function pathLive(p) {
  const bases = ['', 'packages/core/', 'packages/web-v2/', 'packages/runner/'];
  for (const b of bases) {
    const q = b + p;
    if (existsSync(q)) return true;
    const dir = q.replace(/\/[^/]*$/, '');
    const stem = q.slice(dir.length + 1);
    if (stem && existsSync(dir)) {
      try {
        if (readdirSync(dir).some((f) => f === stem || f.startsWith(`${stem}.`))) return true;
      } catch {}
    }
  }
  return false;
}

function controls(corpus) {
  const ghostSym = ['zzQq', 'NotAReal', 'Symbol'].join('');
  const ghostPath = `packages/core/src/${['zz', 'not', 'real'].join('-')}.ts`;
  const checks = [
    ['positive path', pathLive('packages/core/src/index.ts'), true],
    ['negative path', pathLive(ghostPath), false],
    ['positive symbol', corpus.includes('seedBuiltinSkills'), true],
    ['negative symbol', corpus.includes(ghostSym), false],
  ];
  const bad = checks.filter(([, got, want]) => got !== want);
  if (bad.length) die(`controls failed (${bad.map(([n]) => n).join(', ')}) — refusing to report`);
  return checks;
}

// A path starts a token (so `forge-local-docs/x` is not read as `docs/x`), and one that runs into
// a glob character is a pattern, not a file, so it is not judged as a path.
const PATH_RE =
  /(?<![\w./@-])(?:packages|scripts|docs|drizzle|\.forge|\.github)\/[A-Za-z0-9_./@-]+(?![A-Za-z0-9_./@-]*[*?{])/g;
const SYM_RE = /`([A-Za-z_][A-Za-z0-9_]{4,60})`/g;
const HEXISH = /^[0-9a-f]{6,40}$/i;
const OPAQUE = /^[a-z0-9]{16,}$/;
function citedSymbols(text) {
  const out = new Set();
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
    const anchored = PATH_RE.test(line);
    PATH_RE.lastIndex = 0;
    if (!anchored) continue;
    for (const m of line.matchAll(SYM_RE)) {
      const s = m[1];
      if (HEXISH.test(s) || OPAQUE.test(s)) continue;
      out.add(s);
    }
  }
  return out;
}
const LINK_RE = /\[\[([^\]]+)\]\]/g;
const GONE =
  /\b(deleted|removed|gone|retired|no longer|used to|superseded|gutted|gutting|gutted|was deleted|gutted)\b/i;

function entriesFromFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    die(`--entries ${path} is not readable JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) die(`--entries ${path} holds no array of knowledge entries`);
  return parsed;
}

const [memRaw, knRaw] = ENTRIES_FILE
  ? [[], entriesFromFile(ENTRIES_FILE)]
  : await Promise.all([
      (async () => {
        const rows = [];
        for (const source of ['knowledge', 'note', 'policy', 'decision']) {
          for (let off = 0; ; off += 100) {
            const d = await get(
              `/api/memory?projectId=${PROJECT}&source=${source}&limit=100&offset=${off}`,
            );
            rows.push(...(d.items ?? []));
            if ((d.items ?? []).length < 100) break;
          }
        }
        return rows;
      })(),
      (async () => {
        const list = await get(`/api/projects/${PROJECT}/knowledge`);
        return Promise.all(
          (list.rows ?? []).map((r) => get(`/api/projects/${PROJECT}/knowledge/${r.slug}`)),
        );
      })(),
    ]);

const docs = [
  ...memRaw.map((r) => ({ id: r.sourceRef, kind: r.source, text: r.textContent })),
  ...knRaw.map((e) => ({ id: e.slug, kind: 'entry', text: e.body ?? '', entry: e })),
];
if (docs.length === 0) die('the stores came back empty — that is a fetch failure, not a clean run');

const corpus = buildCorpus(['packages', 'scripts', 'docs', '.forge', '.github']);
if (corpus.length < 1_000_000)
  die(`corpus is only ${corpus.length} chars — run me from the repo root`);
const ctl = controls(corpus);

const live = new Set(docs.map((d) => d.id));
const findings = [];
const owing = [];
// a knowledge entry's source first: what the entry says it rests on (ISS-1064)
for (const d of docs) {
  if (!d.entry) continue;
  for (const f of deadSourceAnchors(d.entry.source, process.cwd(), { ignored: gitIgnored }))
    findings.push({ doc: d.id, kind: f.kind, anchor: f.anchor, obituary: false });
  const fields = owedFields(d.entry);
  if (fields.length > 0) owing.push({ doc: d.id, kind: d.entry.kind, fields });
}
for (const d of docs) {
  const obituary = GONE.test(d.text);
  for (const p of new Set(d.text.match(PATH_RE) ?? [])) {
    const q = p.replace(/[.,;:`)]+$/, '');
    if (!pathLive(q) && !gitIgnored(q))
      findings.push({ doc: d.id, kind: 'path', anchor: p, obituary });
  }
  for (const m of citedSymbols(d.text))
    if (!corpus.includes(m)) findings.push({ doc: d.id, kind: 'symbol', anchor: m, obituary });
  for (const m of new Set([...d.text.matchAll(LINK_RE)].map((x) => x[1])))
    if (!live.has(m)) findings.push({ doc: d.id, kind: 'link', anchor: m, obituary: false });
}

const hard = findings.filter((f) => !f.obituary);
const soft = findings.filter((f) => f.obituary);

if (JSON_OUT) {
  console.log(JSON.stringify({ docs: docs.length, hard, soft, owing }, null, 2));
} else {
  console.log(
    `check-memory-anchors · ${docs.length} documents · ${PROJECT ? `project ${PROJECT.slice(0, 8)}` : `entries ${ENTRIES_FILE}`}`,
  );
  console.log(`  controls: ${ctl.map(([n]) => n).join(' ok, ')} ok`);
  const by = new Map();
  for (const f of hard) (by.get(f.doc) ?? by.set(f.doc, []).get(f.doc)).push(f);
  if (hard.length === 0) console.log('\n  no dead anchors outside obituary rows');
  else {
    console.log(`\n  ${hard.length} DEAD anchor(s) in ${by.size} document(s):`);
    for (const [doc, fs] of [...by].sort())
      for (const f of fs) console.log(`    ${doc}  [${f.kind}]  ${f.anchor}`);
  }
  console.log(
    `\n  ${soft.length} dead anchor(s) inside rows that say the thing is gone — read, never trusted as clean`,
  );
  console.log(
    `\n  ${owing.length} entr${owing.length === 1 ? 'y owes' : 'ies owe'} source, scope or recheckWhen — amnesty knowledge-entries-without-provenance, ended when each is rewritten with them or deleted`,
  );
  for (const o of owing) console.log(`    ${o.doc}  [${o.kind}]  ${o.fields.join(', ')}`);
}
process.exit(hard.length > 0 ? 1 : 0);
