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
// So this gate asks, for each route under each project-reach prefix, whether its
// handler reaches the fence, following nested routers down from `index.ts`. An
// account-reach resource is refused to every project-scoped token at the door, and
// a path in `PAT_UNGRANTABLE` is not a token's to reach, so neither is walked. It also holds the declaration to being a menu: a resource
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

const FUNNELS = [
  'effectiveProjectRole',
  'loadProjectAccess',
  'assertProjectAccess',
  'resolveProjectIdFromSlug',
];

const EXEMPT = [
  {
    file: 'projects/project-facts-routes.ts',
    path: '/:id/project-facts',
    why: 'answers 410 Gone and reads nothing (ISS-1048 retired the field)',
  },
  {
    file: 'runners/routes.ts',
    path: '/types',
    why: 'the static list of runner adapters this build registers; no project data',
  },
  {
    file: 'domain-templates/routes.ts',
    path: '/',
    why: 'the global domain-template catalogue, one table no project owns',
  },
  {
    file: 'domain-templates/routes.ts',
    path: '/:key',
    why: 'one entry of the same global catalogue',
  },
];

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

function objectBody(src, name) {
  const start = src.indexOf(`${name}`);
  if (start === -1) die(`could not find ${name} in ${PERMISSIONS}`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n}', open);
  if (open === -1 || close === -1) die(`could not read the ${name} object body`);
  return src.slice(open + 1, close);
}

function permissionResources() {
  const body = objectBody(readFileSync(PERMISSIONS, 'utf8'), 'PAT_PERMISSION_RESOURCES = {');
  const out = new Map();
  const entry =
    /(?:'([^']+)'|([A-Za-z0-9_]+))\s*:\s*\{\s*reach:\s*'([a-z]+)'\s*,\s*prefixes:\s*\{([^}]*)\}\s*,?\s*\}/g;
  for (const m of body.matchAll(entry)) {
    const prefixes = [...m[4].matchAll(/'(\/[^']*)'\s*:\s*(\d+)/g)].map((p) => p[1]);
    out.set(m[1] ?? m[2], { reach: m[3], prefixes });
  }
  if (out.size === 0) {
    die('PAT_PERMISSION_RESOURCES parsed as empty — refusing to pass vacuously');
  }
  const declared = [...body.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1]);
  const attributed = [...out.values()].flatMap((r) => r.prefixes);
  if (declared.length !== attributed.length) {
    die(
      `parsed ${attributed.length} of ${declared.length} prefix(es) in PAT_PERMISSION_RESOURCES — ` +
        'the parser is behind the declaration; fix it rather than walking the part it understood',
    );
  }
  return out;
}

/** The declared exclusions, read from their declaration rather than restated. */
function ungrantable() {
  const body = objectBody(readFileSync(PERMISSIONS, 'utf8'), 'PAT_UNGRANTABLE');
  const out = [...body.matchAll(/^\s*'((?:[A-Z]+ )?\/[^']*)'\s*:/gm)].map((m) => m[1]);
  if (out.length === 0) die('PAT_UNGRANTABLE parsed as empty — refusing to pass vacuously');
  return out;
}

/** Whether an exclusion entry, method-led or not, covers this route. */
function excludes(entry, path, method) {
  const space = entry.indexOf(' ');
  if (space !== -1 && entry.slice(0, space) !== method) return false;
  return patternMatches(entry.slice(space + 1), path);
}

function patternMatches(pattern, path) {
  const want = pattern.split('/');
  const have = path.split('/');
  if (have.length < want.length) return false;
  return want.every((seg, i) => (seg.startsWith(':') ? (have[i] ?? '') !== '' : seg === have[i]));
}

function declarationFindings(resources, excluded) {
  const found = [];
  for (const [resource, { reach, prefixes }] of resources) {
    if (reach !== 'project' && reach !== 'account') {
      found.push({
        file: 'auth/pat-permissions.ts',
        path: resource,
        method: '-',
        why: `reach '${reach}' is neither project nor account, so no door knows how to fence it`,
      });
    }
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
  for (const [resource, { prefixes }] of resources) {
    for (const prefix of prefixes) owners.set(prefix, [...(owners.get(prefix) ?? []), resource]);
  }
  const all = [...owners.keys()];
  for (const inner of all) {
    const outer = all.find((p) => p !== inner && inner.startsWith(`${p}/`));
    if (outer) {
      found.push({
        file: 'auth/pat-permissions.ts',
        path: inner,
        method: '-',
        why: `sits inside ${outer} — which prefix a path under both belongs to would rest on declaration order`,
      });
    }
  }
  for (const entry of excluded) {
    const cancelled = all.find((p) => excludes(entry, p, entry.split(' ')[0] ?? ''));
    if (cancelled) {
      found.push({
        file: 'auth/pat-permissions.ts',
        path: entry,
        method: '-',
        why: `excludes the whole of menu prefix ${cancelled}, so a permission would grant nothing`,
      });
    }
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

/**
 * The routers one router nests with `var.route('<sub>', other)`, each resolved
 * to the file defining it: this file where it is declared here, else the file
 * it is imported from.
 */
function nestedOf(file, varName) {
  const src = read(file);
  if (!src) return [];
  const imports = importsOf(file);
  const out = [];
  const re = new RegExp(
    `^\\s*${varName}\\.route\\(\\s*'([^']*)'\\s*,\\s*([A-Za-z0-9_]+)\\s*\\)`,
    'gm',
  );
  for (const m of src.matchAll(re)) {
    const local = new RegExp(`(?:export\\s+)?const\\s+${m[2]}\\s*=`).test(src);
    out.push({ sub: m[1], varName: m[2], file: local ? file : (imports.get(m[2]) ?? null) });
  }
  return out;
}

function joinPath(mount, sub) {
  if (sub === '' || sub === '/') return mount;
  return mount === '/' ? sub : `${mount}${sub}`;
}

const resources = permissionResources();
const excluded = ungrantable();
const prefixes = [...new Set([...resources.values()].flatMap((r) => r.prefixes))].sort();
const projectPrefixes = [...resources.values()]
  .filter((r) => r.reach === 'project')
  .flatMap((r) => r.prefixes);
const groups = resources.size * permissionLevels().length;
const mounts = routerFiles();
const findings = declarationFindings(resources, excluded);
const exemptHit = new Set();
let routesChecked = 0;
const filesChecked = new Set();

const under = (path, list) => list.some((p) => path === p || path.startsWith(`${p}/`));
const walked = (path, method) =>
  under(path, projectPrefixes) && !excluded.some((entry) => excludes(entry, path, method));
const leadsTo = (mount) =>
  under(mount, projectPrefixes) ||
  mount === '/' ||
  projectPrefixes.some((p) => p.startsWith(`${mount}/`));

function walk(mount, file, varName, trail) {
  if (!file) {
    findings.push({
      file: '(unresolved)',
      path: mount,
      method: '-',
      why: `\`${varName}\` is mounted at ${mount} (via ${trail}) but the file defining it could not be resolved`,
    });
    return;
  }
  const routes = routesOf(file, varName);
  if (routes === null) {
    findings.push({
      file,
      path: mount,
      method: '-',
      why: `router file reached via ${trail} could not be read`,
    });
    return;
  }
  const imports = importsOf(file);
  const fenceNames = [...FUNNELS, ...localFunnels(file)];
  for (const [sym, target] of imports) if (moduleReachesFence(target)) fenceNames.push(sym);
  filesChecked.add(file);
  for (const r of routes) {
    if (r.path !== null && !walked(joinPath(mount, r.path), r.method)) continue;
    routesChecked += 1;
    if (r.path === null) {
      findings.push({
        file,
        path: `${mount}(line ${r.line + 1})`,
        method: r.method,
        why: 'the path argument could not be parsed — fix the parser rather than skipping the route',
      });
      continue;
    }
    const ex = EXEMPT.find((e) => e.file === file && e.path === r.path);
    if (ex) {
      exemptHit.add(`${ex.file} ${ex.path}`);
      continue;
    }
    if (fenceNames.some((f) => r.body.includes(`${f}(`))) continue;
    findings.push({
      file,
      path: joinPath(mount, r.path),
      method: r.method,
      why: 'reaches no fence funnel — a project-scoped token is not fenced on it',
    });
  }
  for (const n of nestedOf(file, varName)) {
    const at = joinPath(mount, n.sub);
    if (leadsTo(at)) walk(at, n.file, n.varName, `${trail} > ${n.varName}`);
  }
}

for (const mount of mounts.filter((m) => leadsTo(m.mount))) {
  walk(mount.mount, mount.file, mount.varName, mount.varName);
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
    `${prefixes.length} covered prefix(es) · ${filesChecked.size} router file(s) · ` +
    `${routesChecked} route(s) · ${findings.length} finding(s)`,
);

if (findings.length) {
  console.error(
    `\npat-surface: ${findings.length} finding(s).` +
      '\nFor an unfenced route: route the handler through' +
      '\n`loadProjectAccess`/`effectiveProjectRole`, drop the prefix from its resource in' +
      '\n`packages/core/src/auth/pat-permissions.ts`, or — only if it reads no project-scoped' +
      '\ndata — add it to EXEMPT here with the reason.' +
      '\nFor a declaration finding: fix PAT_PERMISSION_RESOURCES or PAT_UNGRANTABLE, which are' +
      '\nthe menu and what is kept off it.',
  );
}

process.exit(findings.length ? 1 : 0);
