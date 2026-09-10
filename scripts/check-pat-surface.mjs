#!/usr/bin/env node

// The proof behind the PAT route allowlist.
//
// `PAT_ALLOWED_PREFIXES` decides which REST paths a personal access token may
// reach. Its guard says a prefix is admissible only when a project-scoped token
// can be FENCED on it, and the fence is `effectiveProjectRole`: it reads the
// request's `fencedProjectIds()` out of AsyncLocalStorage and answers `null` for
// a project the token may not name, so every route funnelling through it is
// fenced whether or not its path carries a projectId.
//
// Nothing checked that. The list is per-PREFIX while the property is per-ROUTE,
// so one unfenced route under an admitted prefix is a token reaching another
// project's data with every handler around it looking correct — the shape the
// guard records from `requireAnyAuth`, found only because someone read it.
//
// So this gate asks the question the list has always assumed: for each route
// under each allowlisted prefix, does its handler reach the fence, or is it
// declared to read no project data at all?
//
// Exit codes: 0 clean, 1 an unfenced route under an allowlisted prefix, 2 could
// not run.

import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core', 'src');
const SURFACE = join(CORE, 'middleware', 'pat-rest-surface.ts');
const INDEX = join(CORE, 'index.ts');

function die(msg) {
  console.error(`pat-surface: ${msg}`);
  process.exit(2);
}

// cm:guard the funnel set is the FENCED entry points of lib/authz.ts and nothing else — every name here must reach `effectiveProjectRole`, which is the only function that reads `fencedProjectIds()`. Adding a helper that merely looks authorization-shaped (a role comparison, an org read) makes this gate pass routes the fence never sees, which is worse than no gate: it certifies them.
const FUNNELS = [
  'effectiveProjectRole',
  'loadProjectAccess',
  'assertProjectAccess',
  'resolveProjectIdFromSlug',
];

// cm:guard an exemption says "this route reads NO project-scoped data", which is a claim about the handler, not a waiver — and each entry must still match a live route or this gate fails, so the list cannot rot into permission for something that changed underneath it.
const EXEMPT = [];

/** The allowlist, read from its declaration rather than restated here. */
function allowedPrefixes() {
  const src = readFileSync(SURFACE, 'utf8');
  const block = src.match(/PAT_ALLOWED_PREFIXES[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) die(`could not find PAT_ALLOWED_PREFIXES in ${SURFACE}`);
  const out = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (out.length === 0) die('PAT_ALLOWED_PREFIXES parsed as empty — refusing to pass vacuously');
  return out;
}

const fileCache = new Map();
function read(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  let src = null;
  try {
    src = readFileSync(join(CORE, rel), 'utf8');
  } catch {
    src = null;
  }
  fileCache.set(rel, src);
  return src;
}

/** Intra-core imports of one file, as `symbol -> relative source file`. */
function importsOf(rel) {
  const src = read(rel);
  if (!src) return new Map();
  const out = new Map();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = normalize(join(dirname(rel), spec.replace(/\.js$/, '.ts')));
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) out.set(name, target);
    }
  }
  return out;
}

// cm:guard the closure answers "does this MODULE reach the fence", never "is this module authorized" — it is one half of the test and useless alone. A route passes only when it CALLS a symbol that resolves into this set, so a module that merely sits in the same import graph proves nothing.
const reaches = new Map();
function moduleReachesFence(rel, seen = new Set()) {
  if (reaches.has(rel)) return reaches.get(rel);
  if (seen.has(rel)) return false;
  seen.add(rel);
  const src = read(rel);
  if (!src) {
    reaches.set(rel, false);
    return false;
  }
  if (FUNNELS.some((f) => src.includes(`${f}(`))) {
    reaches.set(rel, true);
    return true;
  }
  let hit = false;
  for (const target of new Set(importsOf(rel).values())) {
    if (moduleReachesFence(target, seen)) {
      hit = true;
      break;
    }
  }
  reaches.set(rel, hit);
  return hit;
}

/** File-local functions whose own body reaches the fence, to a fixpoint. */
function localFunnels(rel) {
  const src = read(rel);
  if (!src) return new Set();
  const bodies = new Map();
  for (const m of src.matchAll(
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/g,
  )) {
    const start = m.index ?? 0;
    const next = src.indexOf('\nfunction ', start + 1);
    bodies.set(m[1], src.slice(start, next === -1 ? src.length : next));
  }
  const known = new Set(FUNNELS);
  const imports = importsOf(rel);
  for (const [sym, target] of imports) if (moduleReachesFence(target)) known.add(sym);
  const local = new Set();
  for (let pass = 0; pass < 4; pass += 1) {
    let grew = false;
    for (const [name, body] of bodies) {
      if (local.has(name)) continue;
      if ([...known, ...local].some((f) => body.includes(`${f}(`))) {
        local.add(name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return local;
}

/** `var name` -> source file, from index.ts's own imports and mounts. */
function routerFiles() {
  const src = readFileSync(INDEX, 'utf8');
  const byVar = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([^']+)\.js'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) byVar.set(name, `${m[2]}.ts`);
    }
  }
  const mounts = [];
  for (const m of src.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
    mounts.push({ mount: m[1], varName: m[2], file: byVar.get(m[2]) ?? null });
  }
  if (mounts.length === 0) die('no app.route mounts found — the parser is out of date');
  return mounts;
}

/**
 * Every route in one router file, as a span of lines.
 *
 * The span runs from a registration to the next one, which approximates the
 * handler body and is sound here: this codebase registers one route per call,
 * in order, and a fence call for route N never sits after route N+1.
 */
function routesOf(file, varName) {
  const src = read(file);
  if (src === null) return null;
  const lines = src.split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const bare = lines[i].match(/^\s*([A-Za-z0-9_]+)\.(get|post|patch|put|delete)\(\s*$/);
    const inline = lines[i].match(
      /^\s*([A-Za-z0-9_]+)\.(get|post|patch|put|delete)\(\s*'([^']*)'\s*[,)]/,
    );
    if (inline && inline[1] === varName) {
      marks.push({ line: i, method: inline[2].toUpperCase(), path: inline[3] });
    } else if (bare && bare[1] === varName) {
      const next = lines[i + 1]?.match(/^\s*'([^']*)'\s*[,)]?\s*$/);
      if (!next) {
        marks.push({ line: i, method: bare[2].toUpperCase(), path: null });
      } else {
        marks.push({ line: i, method: bare[2].toUpperCase(), path: next[1] });
      }
    }
  }
  return marks.map((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].line : lines.length;
    return { ...mk, body: lines.slice(mk.line, end).join('\n') };
  });
}

const prefixes = allowedPrefixes();
const mounts = routerFiles();
const findings = [];
const exemptHit = new Set();
let routesChecked = 0;
let filesChecked = 0;

const relevant = mounts.filter((m) =>
  prefixes.some((p) => m.mount === p || m.mount.startsWith(`${p}/`)),
);

for (const mount of relevant) {
  if (!mount.file) {
    findings.push({
      file: '(unresolved)',
      path: mount.mount,
      method: '-',
      why: `mounted at an allowlisted prefix as \`${mount.varName}\` but its import could not be resolved`,
    });
    continue;
  }
  const routes = routesOf(mount.file, mount.varName);
  const imports = importsOf(mount.file);
  const fenceNames = [...FUNNELS, ...localFunnels(mount.file)];
  for (const [sym, target] of imports) if (moduleReachesFence(target)) fenceNames.push(sym);
  if (routes === null) {
    findings.push({
      file: mount.file,
      path: mount.mount,
      method: '-',
      why: 'router file named by index.ts could not be read',
    });
    continue;
  }
  filesChecked += 1;
  for (const r of routes) {
    routesChecked += 1;
    if (r.path === null) {
      findings.push({
        file: mount.file,
        path: `${mount.mount}(line ${r.line + 1})`,
        method: r.method,
        why: 'the path argument could not be parsed — fix the parser rather than skipping the route',
      });
      continue;
    }
    const ex = EXEMPT.find((e) => e.file === mount.file && e.path === r.path);
    if (ex) {
      exemptHit.add(`${ex.file} ${ex.path}`);
      continue;
    }
    if (fenceNames.some((f) => r.body.includes(`${f}(`))) continue;
    findings.push({
      file: mount.file,
      path: `${mount.mount}${r.path}`,
      method: r.method,
      why: 'reaches no fence funnel — a project-scoped token is not fenced on it',
    });
  }
}

for (const e of EXEMPT) {
  if (!exemptHit.has(`${e.file} ${e.path}`)) {
    findings.push({
      file: e.file,
      path: e.path,
      method: '-',
      why: 'EXEMPT entry matches no live route — delete it rather than leaving a standing exemption',
    });
  }
}

if (routesChecked === 0) die('checked zero routes — the parser found nothing, which is not a pass');

for (const f of findings) {
  console.error(`${f.file} ${f.method} ${f.path}`);
  console.error(`  ${f.why}`);
}

console.log(
  `pat-surface: ${prefixes.length} allowlisted prefix(es) · ${filesChecked} router file(s) · ` +
    `${routesChecked} route(s) · ${findings.length} unfenced`,
);

if (findings.length) {
  console.error(
    `\npat-surface: ${findings.length} route(s) under an allowlisted prefix are not fenced.` +
      '\nRoute the handler through `loadProjectAccess`/`effectiveProjectRole`, drop the prefix from' +
      '\nPAT_ALLOWED_PREFIXES, or — only if it reads no project-scoped data — add it to EXEMPT here' +
      '\nwith the reason.',
  );
}

process.exit(findings.length ? 1 : 0);
