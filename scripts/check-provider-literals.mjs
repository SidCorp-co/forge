#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMode, readManifest } from './lib/debt-ratchet.mjs';
import { dieAs, ROOT, walkFiles } from './lib/gate.mjs';
import {
  allowedFaults,
  byFile,
  coverageFaults,
  scanEgress,
  scanEntries,
} from './lib/provider-literals.mjs';

const die = dieAs('check-provider-literals');

const TYPES_PATH = 'packages/core/src/integrations/types.ts';
const SKIP_DIRS = ['node_modules', 'dist', 'coverage', '.next', '.turbo'];

function declaredProviders() {
  const path = join(ROOT, TYPES_PATH);
  if (!existsSync(path)) return { error: `${TYPES_PATH} not found — nothing declares the set` };
  const text = readFileSync(path, 'utf8');
  const block = /export const INTEGRATION_PROVIDERS\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!block) return { error: `${TYPES_PATH} declares no INTEGRATION_PROVIDERS array` };
  const names = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) return { error: `INTEGRATION_PROVIDERS in ${TYPES_PATH} is empty` };
  return { names };
}

const parsed = parseMode(process.argv, ['--all'], 'check-provider-literals.mjs');
if (parsed.error) die(parsed.error);

const { manifest, error } = readManifest(ROOT);
if (error) die(error);

const cfg = manifest?.checkers?.['provider-literals'];
if (!cfg) die('.forge/conformance.json declares no checkers["provider-literals"] block');

const scanRoots = cfg.scanRoots ?? [];
const scanExts = cfg.scanExts ?? ['.ts', '.tsx'];
if (!Array.isArray(scanRoots) || scanRoots.length === 0) {
  die('checkers["provider-literals"].scanRoots is empty — nothing would be measured');
}

const declared = declaredProviders();
if (declared.error) die(declared.error);

const egress = cfg.egress;
const egressFaults = [];
if (!egress) egressFaults.push('declares no `egress` block — external calls would go unmeasured');
else {
  if (typeof egress.root !== 'string') egressFaults.push('egress.root is not a path');
  if (typeof egress.adapters !== 'string') egressFaults.push('egress.adapters is not a glob');
  if (!Array.isArray(egress.vendorSdks) || egress.vendorSdks.length === 0) {
    egressFaults.push('egress.vendorSdks is empty — no SDK import would ever be refused');
  }
  egressFaults.push(...allowedFaults(egress.exceptions).map((f) => `egress exception: ${f}`));
}

const configFaults = [
  ...allowedFaults(cfg.allowed),
  ...coverageFaults(declared.names, cfg.providers, cfg.unscannable),
  ...egressFaults,
];
if (configFaults.length > 0) {
  console.error(
    `check-provider-literals: ${configFaults.length} fault(s) in ` +
      '.forge/conformance.json → checkers["provider-literals"]:\n',
  );
  for (const fault of configFaults) console.error(`  ${fault}`);
  console.error(
    '\nAn allowed location is a rule switched off for a subtree, so it carries the reason\n' +
      "it is correct there — that is this issue's own acceptance criterion, and a line\n" +
      'nobody can read the reason for is a line nobody can retire. Exit 2: the checker\n' +
      'cannot vouch for a scope it cannot read.\n',
  );
  process.exit(2);
}

const files = [];
for (const root of scanRoots) {
  if (!existsSync(join(ROOT, root))) die(`scan root missing: ${root}`);
  walkFiles(
    root,
    {
      skipDirs: SKIP_DIRS,
      keep: (_, name) =>
        !/\.(test|fixture)\.tsx?$/.test(name) && scanExts.some((ext) => name.endsWith(ext)),
    },
    files,
  );
}

const entries = files.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
const { scanned, offenders } = scanEntries(entries, {
  providers: cfg.providers,
  allowed: cfg.allowed,
});

if (scanned === 0) {
  die(`scanned 0 files under ${scanRoots.join(', ')} — the scope matched nothing`);
}

for (const excused of cfg.unscannable ?? []) {
  console.log(`provider-literals: not scanned — ${excused.provider}: ${excused.why}`);
}

console.log(`provider-literals: ${scanned} file(s) scanned`);

const egressScan = scanEgress(
  entries.filter((e) => e.path.startsWith(`${egress.root}/`)),
  egress,
);
if (egressScan.scanned === 0) die(`egress: scanned 0 files under ${egress.root}`);
console.log(
  `provider-literals egress: ${egressScan.scanned} file(s) outside ${egress.adapters} scanned, ` +
    `${egress.exceptions.length} named exception(s)`,
);
if (egressScan.offenders.length > 0) {
  console.error(
    `\ncheck-provider-literals: ${egressScan.offenders.length} vendor SDK import(s) outside ` +
      `${egress.adapters}\n`,
  );
  for (const o of egressScan.offenders) {
    console.error(`  ${o.path}:${o.line}  the vendor SDK '${o.what}'`);
  }
  console.error(
    '\nEvery external system is reached through one adapter under packages/core/src/integrations/\n' +
      '(docs/adr/0006-every-external-system-is-reached-through-one-adapter-port.md). Move the import\n' +
      "behind its port's typed function, or add a port; integrations/README.md lists them. A file\n" +
      'that genuinely must import the SDK itself is added to checkers["provider-literals"].egress.exceptions\n' +
      'in .forge/conformance.json WITH the sentence saying why. An entry with no reason is refused.\n',
  );
}
if (offenders.length === 0) process.exit(egressScan.offenders.length > 0 ? 1 : 0);

const grouped = byFile(offenders);
console.error(
  `\ncheck-provider-literals: ${grouped.length} file(s) name a provider outside the ` +
    `${cfg.allowed.length} declared allowed locations\n`,
);
for (const { path, providers, lines } of grouped) {
  console.error(`  ${path}`);
  console.error(
    `    ${providers.join(', ')}  (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')})`,
  );
}
console.error(
  `\n${offenders.length} literal(s) across ${grouped.length} file(s).\n` +
    '\n' +
    'Each of these is a place that must be edited when a provider is added, and that\n' +
    'stays silently correct for the providers it already lists when it is not. Ask the\n' +
    'registry instead — `getIntegration`, `listIntegrations`, `providerCanDeploy`,\n' +
    '`directMcpIntegrations` and `mcpServerNameFor` in\n' +
    'packages/core/src/integrations/registry.ts answer without naming anyone.\n' +
    '\n' +
    "Where the name genuinely belongs — the provider's own directory, the registry, the\n" +
    'schema vocabulary, a contracts enum — add the location to\n' +
    '.forge/conformance.json → checkers["provider-literals"].allowed WITH the sentence\n' +
    'saying what makes it correct there. An entry with no reason is refused.\n',
);
process.exit(1);
