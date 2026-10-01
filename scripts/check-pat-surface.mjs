#!/usr/bin/env node

// The proof behind the PAT permission menu.
//
// `PAT_PERMISSION_RESOURCES` (packages/core/src/auth/pat-permissions.ts) declares which REST
// prefixes a personal access token may reach. A project-reach prefix is admissible only when a
// project-scoped token is FENCED on every route under it, and the fence is one function:
// `fencedProjectIds`, the read of the token's projects out of AsyncLocalStorage. The declaration
// is per-PREFIX while the property is per-ROUTE, so one unfenced route under a covered prefix is
// a token reaching another project's data with every handler around it looking correct.
//
// So the routes, the menu and `PAT_UNGRANTABLE` come from the RUNNING app under the contract
// generator's hermetic environment — what is checked is what is served — and each route under
// a project-reach prefix must match a registration the type checker finds from `index.ts` whose
// handlers, or preceding middleware, reach the fence (scripts/lib/route-fences.mjs). The
// declaration is also held to being a menu: no resource without a prefix, no prefix two claim.
//
// Exit codes: 0 clean, 1 an unfenced route or a malformed declaration, 2 could not run.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { absentPrerequisites, couldNotStart, remedyLines } from './lib/prerequisite.mjs';
import { routeFences } from './lib/route-fences.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ROUTE_TABLE = join(CORE, 'src', 'api-contract', 'route-table.ts');
const FENCE = { file: 'auth/pat-scope.ts', name: 'fencedProjectIds' };

function die(msg) {
  console.error(`pat-surface: ${msg}`);
  process.exit(2);
}

const EXEMPT = [
  {
    route: 'GET /api/projects/:id/project-facts',
    why: 'answers 410 Gone and reads nothing (ISS-1048 retired the field)',
  },
  {
    route: 'PATCH /api/projects/:id/project-facts',
    why: 'answers 410 Gone and reads nothing (ISS-1048 retired the field)',
  },
  {
    route: 'POST /api/projects/:projectId/integrations',
    why: 'answers 410 BINDING_WRITE_MOVED and reads nothing (ISS-15: a binding is written as its binding-v1 document)',
  },
  {
    route: 'POST /api/body/preview',
    why: 'renders the body sent in the request and nothing else; it reads no stored row',
  },
  {
    route: 'GET /api/runners/types',
    why: 'the static list of runner adapters this build registers; no project data',
  },
  {
    route: 'GET /api/domain-templates',
    why: 'the global domain-template catalogue, one table no project owns',
  },
  {
    route: 'GET /api/domain-templates/:key',
    why: 'one entry of the same global catalogue',
  },
];

function servedTable() {
  if (process.argv.length > 2) die(`takes no arguments, got: ${process.argv.slice(2).join(' ')}`);
  const missing = absentPrerequisites(ROOT, ['deps', 'observability-build', 'contracts-build']);
  if (missing.length > 0) die(`could not run — ${remedyLines(missing)[0]}`);
  if (!existsSync(ROUTE_TABLE)) die(`${ROUTE_TABLE} not found`);
  const result = spawnSync(TSX, [ROUTE_TABLE], {
    cwd: CORE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (couldNotStart(result))
    die(`${TSX} is not executable here — run: pnpm install --frozen-lockfile`);
  if (result.status !== 0) {
    console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd());
    die(`the route table exited ${result.status}`);
  }
  let table;
  try {
    table = JSON.parse(result.stdout);
  } catch (err) {
    die(`the route table printed something that is not JSON: ${err.message}`);
  }
  if (!Array.isArray(table.routes) || table.routes.length === 0)
    die('the running app serves zero routes — refusing to pass vacuously');
  if (Object.keys(table.resources ?? {}).length === 0)
    die('PAT_PERMISSION_RESOURCES is empty — refusing to pass vacuously');
  if (Object.keys(table.ungrantable ?? {}).length === 0)
    die('PAT_UNGRANTABLE is empty — refusing to pass vacuously');
  if (!Array.isArray(table.levels) || table.levels.length === 0)
    die('PAT_PERMISSION_LEVELS is empty — refusing to report a menu size of zero');
  return table;
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

const declared = (route, why) => ({ route, where: 'auth/pat-permissions.ts', why });

function declarationFindings(resources, excluded) {
  const found = [];
  for (const [resource, { reach, prefixes }] of resources) {
    if (reach !== 'project' && reach !== 'account') {
      found.push(
        declared(
          resource,
          `reach '${reach}' is neither project nor account, so no door knows how to fence it`,
        ),
      );
    }
    if (prefixes.length === 0) {
      found.push(
        declared(
          resource,
          'this resource covers no prefix — a permission nobody can use, so delete it or give it routes',
        ),
      );
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
      found.push(
        declared(
          inner,
          `sits inside ${outer} — which prefix a path under both belongs to would rest on declaration order`,
        ),
      );
    }
  }
  for (const entry of excluded) {
    const cancelled = all.find((p) => excludes(entry, p, entry.split(' ')[0] ?? ''));
    if (cancelled) {
      found.push(
        declared(
          entry,
          `excludes the whole of menu prefix ${cancelled}, so a permission would grant nothing`,
        ),
      );
    }
  }
  for (const [prefix, claiming] of owners) {
    if (claiming.length > 1) {
      found.push(
        declared(
          prefix,
          `claimed by ${claiming.join(' and ')} — a prefix belongs to one resource, or "which permission did this route want" has no answer`,
        ),
      );
    }
  }
  return found;
}

const table = servedTable();
const resources = new Map(
  Object.entries(table.resources).map(([name, r]) => [
    name,
    { reach: r.reach, prefixes: Object.keys(r.prefixes ?? {}) },
  ]),
);
const excluded = Object.keys(table.ungrantable);
const prefixes = [...new Set([...resources.values()].flatMap((r) => r.prefixes))].sort();
const projectPrefixes = [...resources.values()]
  .filter((r) => r.reach === 'project')
  .flatMap((r) => r.prefixes);
const groups = resources.size * table.levels.length;
const findings = declarationFindings(resources, excluded);

const under = (path) => projectPrefixes.some((p) => path === p || path.startsWith(`${p}/`));
const served = [
  ...new Set(
    table.routes
      .filter((r) => r.method !== 'ALL' && under(r.path))
      .filter((r) => !excluded.some((entry) => excludes(entry, r.path, r.method)))
      .map((r) => `${r.method} ${r.path}`),
  ),
].sort();

let proof;
try {
  proof = routeFences({ coreDir: CORE, entry: 'src/index.ts', appName: 'app', fence: FENCE });
} catch (err) {
  die(err.message);
}
const byRoute = new Map();
for (const reg of proof.registrations) {
  const key = `${reg.method} ${reg.path}`;
  byRoute.set(key, [...(byRoute.get(key) ?? []), reg]);
}

const exemptHit = new Set();
const filesChecked = new Set();
for (const route of served) {
  const regs = byRoute.get(route) ?? [];
  for (const reg of regs) filesChecked.add(reg.file);
  const ex = EXEMPT.find((e) => e.route === route);
  if (ex) {
    exemptHit.add(ex.route);
    continue;
  }
  if (regs.length === 0) {
    const hint = proof.unreadable.map((u) => `\n    ${u.file}:${u.line} ${u.why}`).join('');
    findings.push({
      route,
      where: '(no registration)',
      why:
        'served by the running app, but no registration reached from index.ts spells it, so ' +
        `nothing proves it fenced — the calls on a router this proof could not read:${hint || ' none'}`,
    });
    continue;
  }
  for (const reg of regs.filter((r) => !r.fenced)) {
    findings.push({
      route,
      where: `${reg.file}:${reg.line}`,
      why: `no handler or preceding middleware of this registration reaches ${FENCE.name} — a project-scoped token is not fenced on it`,
    });
  }
}

for (const e of EXEMPT) {
  if (!exemptHit.has(e.route)) {
    findings.push({
      route: e.route,
      where: 'scripts/check-pat-surface.mjs EXEMPT',
      why: 'matches no served route under a project prefix — delete it rather than leaving a standing exemption',
    });
  }
}

for (const f of findings) {
  console.error(`${f.route}  (${f.where})`);
  console.error(`  ${f.why}`);
}

console.log(
  `pat-surface: ${resources.size} resource(s) · ${groups} permission group(s) · ` +
    `${prefixes.length} covered prefix(es) · ${filesChecked.size} router file(s) · ` +
    `${served.length} route(s) · ${findings.length} finding(s)`,
);

if (findings.length) {
  console.error(
    `\npat-surface: ${findings.length} finding(s).` +
      '\nFor an unfenced route: route the handler through' +
      '\n`loadProjectAccess`/`effectiveProjectRole`, drop the prefix from its resource in' +
      '\n`packages/core/src/auth/pat-permissions.ts`, keep the path out with a reason in' +
      '\n`PAT_UNGRANTABLE`, or — only if it reads no project-scoped data — add it to EXEMPT' +
      '\nhere with the reason.' +
      '\nFor a declaration finding: fix PAT_PERMISSION_RESOURCES or PAT_UNGRANTABLE, which are' +
      '\nthe menu and what is kept off it.',
  );
}

process.exit(findings.length ? 1 : 0);
