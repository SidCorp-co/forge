#!/usr/bin/env node

// Audits the Forge cloud memory + knowledge stores against THIS checkout: every
// repo path, every backticked identifier and every [[link]] a row cites must
// resolve, or the row is asserting something the tree no longer has.
//
// Exit 0 clean · 1 dead anchors · 2 the check could not run.
//
// Usage:  node scripts/check-memory-anchors.mjs [--json] [--project <uuid>]
// Token:  $FORGE_PAT, else ~/.config/forge/config.json

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const PROJECT =
  process.argv[process.argv.indexOf('--project') + 1]?.match(/^[0-9a-f-]{36}$/)?.[0] ??
  'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
const API = process.env.FORGE_API ?? 'https://forge-beta-api.sidcorp.co';
const JSON_OUT = process.argv.includes('--json');

function die(msg) {
  console.error(`check-memory-anchors: ${msg}`);
  process.exit(2);
}

function token() {
  if (process.env.FORGE_PAT) return process.env.FORGE_PAT;
  const p = join(homedir(), '.config/forge/config.json');
  if (!existsSync(p)) die('no $FORGE_PAT and no ~/.config/forge/config.json');
  const t = JSON.parse(readFileSync(p, 'utf8')).token;
  if (!t) die('config.json carries no token');
  return t;
}

async function get(path) {
  // cm:guard a real User-Agent is required — Cloudflare answers the default fetch/urllib UA with 403 1010 on this host, and a 403 here reads as an auth failure
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token()}`, 'User-Agent': 'curl/8.5.0' },
  });
  if (!res.ok) die(`${path} -> HTTP ${res.status}`);
  return res.json();
}

// cm:why comments are stripped from the corpus before any symbol lookup: this repo writes obituaries — `state-machine.ts` names four helpers it deleted — so a grep over raw source reports a dead identifier as live, which is the exact inversion this gate exists to catch
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

// cm:guard a gitignored path is absent BY DESIGN, not rotted — the local search-eval harness is the standing case, and gating it would teach authors to stop naming where a thing actually lives
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

// cm:guard both controls run BEFORE any result is reported and a failure exits 2, never 0 — a scan that cannot fail is the failure mode this file exists to prevent (measured 2026-09-12: a `compgen`-based version reported 0 of 89 dead paths and passed a fabricated filename)
// cm:guard the negative tokens are ASSEMBLED at runtime, never written whole: this file lives under `scripts/`, which the corpus walks, so a literal sentinel here would find itself and turn the control green against a broken scan
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

const PATH_RE = /\b(?:packages|scripts|docs|drizzle|\.forge|\.github)\/[A-Za-z0-9_./@-]+/g;
const SYM_RE = /`([A-Za-z_][A-Za-z0-9_]{4,60})`/g;
// cm:guard a backticked WORD is not a citation and must not be gated: this corpus quotes git SHAs, Coolify uuids, other systems' table names and plain tool names, and every one of them is legitimately absent from this tree. Only a symbol the row itself anchors to a repo path is a claim about THIS repo — that is the rule `docs-doctrine` §4 already asks authors for, and gating anything looser produced 21 findings of which 17 were noise (measured 2026-09-12).
const HEXISH = /^[0-9a-f]{6,40}$/i;
const OPAQUE = /^[a-z0-9]{16,}$/;
function citedSymbols(text) {
  const out = new Set();
  for (const line of text.split(/\n|(?<=[.!?])\s+/)) {
    // cm:guard the anchor must be a REPO path, never any `*.ts`-shaped filename: this project reaches forge-plugin by issue and cites its files by name, so a loose filename test gates a symbol that lives in a repo this checkout does not contain (`markedCommit` in the plugin's `src/flow/machine.mjs`, measured 2026-09-12)
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
// cm:why a row citing something absent is often CORRECT — naming what was deleted is what an obituary does — so those are reported apart rather than failed, and the split is heuristic, which is why the count is printed instead of hidden
const GONE =
  /\b(deleted|removed|gone|retired|no longer|used to|superseded|gutted|gutting|gutted|was deleted|gutted)\b/i;

const [memRaw, knRaw] = await Promise.all([
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
    const list = await get(`/api/projects/${PROJECT}/knowledge?limit=100`);
    return Promise.all(
      (list.rows ?? []).map((r) => get(`/api/projects/${PROJECT}/knowledge/${r.slug}`)),
    );
  })(),
]);

const docs = [
  ...memRaw.map((r) => ({ id: r.sourceRef, kind: r.source, text: r.textContent })),
  ...knRaw.map((e) => ({ id: e.slug, kind: 'entry', text: e.body ?? '' })),
];
if (docs.length === 0) die('the stores came back empty — that is a fetch failure, not a clean run');

const corpus = buildCorpus(['packages', 'scripts', 'docs', '.forge', '.github']);
if (corpus.length < 1_000_000)
  die(`corpus is only ${corpus.length} chars — run me from the repo root`);
const ctl = controls(corpus);

const live = new Set(docs.map((d) => d.id));
const findings = [];
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
  console.log(JSON.stringify({ docs: docs.length, hard, soft }, null, 2));
} else {
  console.log(`check-memory-anchors · ${docs.length} documents · project ${PROJECT.slice(0, 8)}`);
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
}
process.exit(hard.length > 0 ? 1 : 0);
