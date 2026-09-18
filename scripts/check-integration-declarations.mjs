#!/usr/bin/env node
// Walk the LIVE integration registry and refuse a declaration that is missing a
// field the generic paths read.
//
// It walks the registry rather than the source because the source is not what
// runs: a declaration can be spread from a partial, widened on its way in, or
// assembled by a helper, and `tsc` has signed off on all three. What reaches the
// map is what every generic path will ask, so that is what is measured.
//
// The rule with teeth is ISS-1071 rule 2: a `direct-mcp` arm renders the
// project's credential into a runner box's MCP config, putting Forge outside the
// call path, and a provider taking that route says in its own declaration why it
// offers no core-mediated one. An empty `justification` fails NAMING the
// provider. Deleting the field does not weaken a message — it removes the only
// place that decision is written down.
//
// ## How a .mjs script reaches a TypeScript registry, and the one trap in it
//
// It generates a probe, spawns `tsx` on it, and reads a JSON projection printed
// between two sentinels. Core's env schema validates at import time, so the
// probe is given synthetic values for the three variables it requires: a
// conformance checker must not read an operator's DATABASE_URL and must not be
// able to reach a real database.
//
// The probe is written INSIDE the entrypoint's own package, and that is
// load-bearing rather than tidy. Measured 2026-09-17: a probe under `scripts/`
// or under the system temp directory importing
// `packages/core/src/integrations/registry.ts` gets a SECOND instance of that
// module — `registerIntegration === registerIntegration` is false across the
// boundary, so the registrar fills one Map and the probe reads an empty one, and
// the checker reports "the registry holds no declaration" about a registry that
// holds eight. Two files in `scripts/` sharing a module proved it is not a tsx
// cache quirk, and moving the probe into `packages/core/` fixed it outright. A
// wrong answer that looks exactly like the failure this checker exists to
// report is worth these eleven lines.
//
// Modes: --all (the only mode — a registry is whole or it is not)
// Exit: 0 every declaration answers · 1 one does not · 2 could not run.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMode, readManifest } from './lib/debt-ratchet.mjs';
import { declarationFaults, unusableReport } from './lib/integration-declarations.mjs';
import { absentPrerequisites, couldNotStart, remedyLines } from './lib/prerequisite.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const REGISTRY = join(ROOT, 'packages', 'core', 'src', 'integrations', 'registry.ts');
const CONTRACT = join(ROOT, 'packages', 'contracts', 'src', 'deploy-capability.ts');
const OPEN = '<<<FORGE_DECLARATIONS';
const CLOSE = 'FORGE_DECLARATIONS>>>';

function die(message) {
  console.error(`check-integration-declarations: ${message}`);
  process.exit(2);
}

/** The nearest ancestor of `file` holding a package.json — the module world the probe must join. */
function packageRootOf(file) {
  let dir = dirname(file);
  while (dir.startsWith(ROOT)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** A relative ESM specifier from `fromDir` to `target`, with the `.ts` written as `.js`. */
function specifier(fromDir, target) {
  const rel = relative(fromDir, target).split(sep).join('/');
  const withJs = rel.replace(/\.ts$/, '.js');
  return withJs.startsWith('.') ? withJs : `./${withJs}`;
}

// cm:guard the probe prints between two sentinels rather than printing bare JSON. Importing core's
// module tree brings the logger with it, and one pino line on stdout at import time would turn a
// working checker into `Unexpected token` — a message about JSON, from which nobody concludes that
// a module logged while loading.
// cm:guard the projection is TYPES and raw values, never the objects themselves: a zod schema and a
// `buildEntry` closure do not survive JSON, and `JSON.stringify` drops a function silently, which
// would make "declares no buildEntry" and "declares one" print identically.
function probeSource({ entrypoint, registry, contract, registerFn }) {
  return `import { ${registerFn} } from '${entrypoint}';
import { listIntegrations } from '${registry}';
import { DEPLOY_CAPABLE_PROVIDERS } from '${contract}';

const report = { providers: [], contractCanDeploy: {} };
${registerFn}();
for (const name of DEPLOY_CAPABLE_PROVIDERS) report.contractCanDeploy[name] = true;

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const BOOLEANS = ['canDispatch','canReceiveWebhook','canDeploy','liveConfirmGate','hasDeliveryLog','multiBinding'];

for (const decl of listIntegrations()) {
  const caps = decl && decl.capabilities;
  const path = caps && caps.agentPath;
  report.providers.push({
    provider: decl && decl.provider,
    capabilities: !caps ? undefined : {
      types: Object.fromEntries(BOOLEANS.map((k) => [k, typeOf(caps[k])])),
      canDeploy: caps.canDeploy,
      canDispatch: caps.canDispatch,
      canReceiveWebhook: caps.canReceiveWebhook,
      webhookHeader: caps.webhookHeader,
      webhookSignatureHeader: caps.webhookSignatureHeader,
      agentPath: {
        present: path !== undefined && path !== null,
        kind: path && path.kind,
        toolsType: path && typeOf(path.tools),
        serverName: path && path.serverName,
        justification: path && path.justification,
        buildEntryType: path && typeOf(path.buildEntry),
      },
    },
    adapter: {
      present: Boolean(decl && decl.adapter),
      dispatchOutboundType: typeOf(decl && decl.adapter && decl.adapter.dispatchOutbound),
    },
    schemas: !decl || !decl.schemas ? { present: false } : {
      present: true,
      declaredKeys: Object.keys(decl.schemas),
      types: Object.fromEntries(Object.entries(decl.schemas).map(([k, v]) => [k, typeOf(v)])),
    },
  });
  if (report.contractCanDeploy[decl.provider] === undefined) {
    report.contractCanDeploy[decl.provider] = false;
  }
}

console.log('${OPEN}');
console.log(JSON.stringify(report));
console.log('${CLOSE}');
// The pool opened by importing the store holds a socket handle, so the probe would finish its
// work and then sit there — which reads to the caller as a checker that hangs rather than answers.
process.exit(0);
`;
}

const parsed = parseMode(process.argv, ['--all'], 'check-integration-declarations.mjs');
if (parsed.error) die(parsed.error);

const missing = absentPrerequisites(ROOT, ['deps']);
if (missing.length > 0) die(`could not run — ${remedyLines(missing)[0]}`);

const { manifest, error } = readManifest(ROOT);
if (error) die(error);

const cfg = manifest?.checkers?.['integration-declarations'] ?? {};
const entrypointRel = cfg.entrypoint ?? 'packages/core/src/integrations/register-all.ts';
const registerFn = cfg.registerFn ?? 'registerAllIntegrations';
const entrypoint = join(ROOT, entrypointRel);

// cm:guard an absent entrypoint is exit 2 and never exit 0. "No declaration is faulty" is exactly
// what a registry nobody populated reports, and the two are indistinguishable downstream — which is
// the fail-closed contract `verify.mjs` holds every checker here to.
if (!existsSync(entrypoint)) {
  die(
    `${entrypointRel} not found — the registry could not be populated, so nothing was walked.\n` +
      '  Declare the right path at .forge/conformance.json → ' +
      'checkers["integration-declarations"].entrypoint.',
  );
}
if (!existsSync(REGISTRY)) die('packages/core/src/integrations/registry.ts not found');
if (!existsSync(CONTRACT)) die('packages/contracts/src/deploy-capability.ts not found');

const pkgRoot = packageRootOf(entrypoint);
if (!pkgRoot) die(`${entrypointRel} sits under no package.json — the probe has no world to join`);

const dir = mkdtempSync(join(pkgRoot, '.forge-declarations-'));
const probe = join(dir, 'probe.mts');
let result;
try {
  writeFileSync(
    probe,
    probeSource({
      entrypoint: specifier(dir, entrypoint),
      registry: specifier(dir, REGISTRY),
      contract: specifier(dir, CONTRACT),
      registerFn,
    }),
  );
  result = spawnSync(TSX, [probe], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      // cm:guard synthetic and NOT inherited. A conformance checker that read the operator's
      // DATABASE_URL could reach a live database from a gate; port 1 on loopback is a value no pool
      // can connect to. The registry needs the module graph, never a query.
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://conformance:conformance@127.0.0.1:1/conformance',
      JWT_SECRET: 'conformance-checker-value-which-is-not-a-secret',
      DEVICE_TOKEN_PEPPER: 'conformance-checker-value-which-is-not-a-secret',
    },
  });
} finally {
  // cm:guard `finally`, because the probe lives in a package source tree rather than in /tmp: a
  // throw between the write and the spawn would otherwise leave a stray .mts inside packages/core
  // for every other gate to trip over.
  rmSync(dir, { recursive: true, force: true });
}

if (couldNotStart(result)) {
  die(`${TSX} is not executable here — run: pnpm install --frozen-lockfile`);
}
if (result.error) die(`could not run the registry probe: ${result.error.message}`);

const stdout = result.stdout ?? '';
const open = stdout.indexOf(OPEN);
const close = stdout.indexOf(CLOSE);
if (open === -1 || close === -1) {
  console.error(
    'check-integration-declarations: the registry probe printed no report. It could not\n' +
      'import the registrar, or it threw while registering. Its own output follows.\n',
  );
  console.error(`${stdout}${result.stderr ?? ''}`.trimEnd());
  process.exit(2);
}

let report;
try {
  report = JSON.parse(stdout.slice(open + OPEN.length, close));
} catch (err) {
  die(`the registry probe's report was not JSON: ${err.message}`);
}

const unusable = unusableReport(report);
if (unusable) die(unusable);

const faults = declarationFaults(report);

console.log(`integration-declarations: ${report.providers.length} provider(s) declared`);
if (faults.length === 0) process.exit(0);

console.error(
  `\ncheck-integration-declarations: ${faults.length} of ${report.providers.length} ` +
    'declaration(s) do not answer what the generic paths ask\n',
);
for (const { provider, reasons } of faults) {
  console.error(`  ${provider}`);
  for (const reason of reasons) console.error(`    ${reason}`);
}
console.error(
  '\nEvery field is required, and the requirement is not decoration: a declaration that\n' +
    'does not answer reads to every generic path as a provider that is inert, and says so\n' +
    'nowhere. The shape is `IntegrationDeclaration` in\n' +
    'packages/core/src/integrations/types.ts; `declareIntegration()` fills in the safer\n' +
    'agent path for a provider that names none, and fills in nothing else.\n',
);
process.exit(1);
