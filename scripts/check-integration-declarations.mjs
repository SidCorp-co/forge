#!/usr/bin/env node

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
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://conformance:conformance@127.0.0.1:1/conformance',
      JWT_SECRET: 'conformance-checker-value-which-is-not-a-secret',
      DEVICE_TOKEN_PEPPER: 'conformance-checker-value-which-is-not-a-secret',
    },
  });
} finally {
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
