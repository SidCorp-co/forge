#!/usr/bin/env node

// The proof behind the PAT permission menu.
//
// `PAT_PERMISSION_RESOURCES` (packages/core/src/auth/pat-permissions.ts) declares
// which REST paths a personal access token may reach, one named resource to the
// prefixes it covers, and `PAT_ALLOWED_PREFIXES` is its union. A prefix is
// admissible only when a project-scoped token can be FENCED on it, and the fence
// is `effectiveProjectRole`: it reads `fencedProjectIds()` out of AsyncLocalStorage
// and answers `null` for a project the token may not name.
//
// Nothing checked that. The declaration is per-PREFIX while the property is
// per-ROUTE, so one unfenced route under a covered prefix is a token reaching
// another project's data with every handler around it looking correct.
//
// So this gate asks, for each route under each covered prefix, whether its handler
// reaches the fence. It also holds the declaration to being a menu: a resource
// covering no route is a permission nobody can use, and a prefix two resources
// claim makes "which permission did this route want" unanswerable.
//
// Exit codes: 0 clean, 1 an unfenced route or a malformed declaration, 2 could not run.

import { readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core', 'src');
const PERMISSIONS = join(CORE, 'auth', 'pat-permissions.ts');
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

/**
 * The permission menu, read from its declaration rather than restated here.
 *
 * Returns `resource -> prefixes`. The union of the values is what
 * `PAT_ALLOWED_PREFIXES` computes at runtime, so walking it here walks exactly
 * the surface a token can reach.
 */
/**
 * The levels, read from the same file rather than restated.
 *
 * Only the reported group count needs them — the fence proof is per-PREFIX and
 * level-blind, exactly as `patAllowedFor` is — but a hardcoded pair here would
 * be the second copy of a declaration whose whole point is having one home.
 */
function permissionLevels() {
  const src = readFileSync(PERMISSIONS, 'utf8');
  const m = src.match(/PAT_PERMISSION_LEVELS\s*=\s*\[([^\]]*)\]/);
  if (!m) die(`could not find PAT_PERMISSION_LEVELS in ${PERMISSIONS}`);
  const out = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (out.length === 0)
    die('PAT_PERMISSION_LEVELS parsed as empty — refusing to report a menu size of zero');
  return out;
}

function permissionResources() {
  const src = readFileSync(PERMISSIONS, 'utf8');
  const start = src.indexOf('PAT_PERMISSION_RESOURCES');
  if (start === -1) die(`could not find PAT_PERMISSION_RESOURCES in ${PERMISSIONS}`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n}', open);
  if (open === -1 || close === -1) die('could not read the PAT_PERMISSION_RESOURCES object body');
  const body = src.slice(open + 1, close);
  const out = new Map();
  for (const m of body.matchAll(/([A-Za-z0-9_]+)\s*:\s*\[([^\]]*)\]/g)) {
    out.set(
      m[1],
      [...m[2].matchAll(/'([^']+)'/g)].map((p) => p[1]),
    );
  }
  // cm:guard zero resources is exit 2, never a pass: a parser that has fallen behind the declaration reports an empty menu, and an empty menu walks no routes, which is the vacuous green this whole gate exists to refuse.
  if (out.size === 0) {
    die('PAT_PERMISSION_RESOURCES parsed as empty — refusing to pass vacuously');
  }
  // cm:guard a PARTIAL parse is the dangerous one, because it neither dies nor walks the whole surface — it silently checks fewer prefixes and reports a green over the rest. So count the prefixes in the declaration independently of how they were attributed: any `/api/...` the resource regex did not claim means the parser has fallen behind the declaration's shape, which is a finding here and never a skip.
  const declared = [...body.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  const attributed = [...out.values()].flat();
  if (declared.length !== attributed.length) {
    die(
      `parsed ${attributed.length} of ${declared.length} prefix(es) in PAT_PERMISSION_RESOURCES — ` +
        'the parser is behind the declaration; fix it rather than walking the part it understood',
    );
  }
  return out;
}

/** A resource covering nothing, or a prefix two resources both claim. */
function declarationFindings(resources) {
  const found = [];
  for (const [resource, prefixes] of resources) {
    if (prefixes.length === 0) {
      found.push({
        file: 'auth/pat-permissions.ts',
        path: resource,
        method: '-',
        why: 'this resource covers no prefix — a permission nobody can use, so delete it or give it routes',
      });
    }
  }
  const owners = new Map();
  for (const [resource, prefixes] of resources) {
    for (const prefix of prefixes) owners.set(prefix, [...(owners.get(prefix) ?? []), resource]);
  }
  for (const [prefix, claiming] of owners) {
    if (claiming.length > 1) {
      found.push({
        file: 'auth/pat-permissions.ts',
        path: prefix,
        method: '-',
        why: `claimed by ${claiming.join(' and ')} — a prefix belongs to one resource, or "which permission did this route want" has no answer`,
      });
    }
  }
  return found;
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

const resources = permissionResources();
const prefixes = [...new Set([...resources.values()].flat())].sort();
const groups = resources.size * permissionLevels().length;
const mounts = routerFiles();
const findings = declarationFindings(resources);
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
  `pat-surface: ${resources.size} resource(s) · ${groups} permission group(s) · ` +
    `${prefixes.length} covered prefix(es) · ${filesChecked} router file(s) · ` +
    `${routesChecked} route(s) · ${findings.length} finding(s)`,
);

if (findings.length) {
  console.error(
    `\npat-surface: ${findings.length} finding(s).` +
      '\nFor an unfenced route: route the handler through' +
      '\n`loadProjectAccess`/`effectiveProjectRole`, drop the prefix from its resource in' +
      '\n`packages/core/src/auth/pat-permissions.ts`, or — only if it reads no project-scoped' +
      '\ndata — add it to EXEMPT here with the reason.' +
      '\nFor a declaration finding: fix PAT_PERMISSION_RESOURCES, which is the menu itself.',
  );
}

process.exit(findings.length ? 1 : 0);
