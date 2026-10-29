import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { enterHermeticEnv } from './api-contract/hermetic-env.js';
import { canonicalJson } from './lib/canonical-json.js';

const GENERATOR = 'packages/core/src/contracts-generate.ts';
const CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(CORE, '..', '..');
const DEFAULT_OUT = join(CORE, 'contracts');
const API_ARTIFACT = 'forge-api.openapi.json';
const MCP_ARTIFACT = 'forge-mcp.tools.json';
const IMAGE_OASDIFF = '/usr/local/bin/oasdiff';

function flag(argv: string[], name: string, what: string): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`api-contract: ${name} needs ${what}`);
    process.exit(2);
  }
  return value;
}

type Floor = { contract: string; version: string; source: string; text: string };
type Base = {
  rev: string;
  basis: string;
  texts: Record<string, string | null>;
  floors: Record<string, Floor | null>;
};

const workingText = (path: string): string | null =>
  existsSync(join(REPO, path)) ? readFileSync(join(REPO, path), 'utf8') : null;

// the base is read before the environment is replaced: which branch this lands on is the caller's
// ($GITHUB_BASE_REF, a push payload, origin/HEAD), and scripts/lib/contract-base.mjs is the one reading of it
async function baseOf(argv: string[]): Promise<Base> {
  const lib = await import(pathToFileURL(join(REPO, 'scripts', 'lib', 'contract-base.mjs')).href);
  const named = flag(argv, '--base-rev', 'a commit');
  const found = named
    ? { rev: named, basis: flag(argv, '--base-basis', 'a sentence') ?? `--base-rev ${named}` }
    : lib.contractBase(REPO, process.env);
  if ('refusal' in found) {
    console.error(`api-contract: no base to number the contracts after — ${found.refusal}`);
    process.exit(2);
  }
  const floor = lib.registryFloor(REPO, workingText);
  if ('refusal' in floor) {
    console.error(
      `api-contract: no registry floor to number the contracts above — ${floor.refusal}`,
    );
    process.exit(2);
  }
  return {
    rev: found.rev,
    basis: found.basis,
    texts: lib.contractsAt(REPO, found.rev),
    floors: floor.floors,
  };
}

const argv = process.argv.slice(2);
const out = resolve(flag(argv, '--out', 'a directory') ?? DEFAULT_OUT);
const base = await baseOf(argv);
const callerOasdiff = process.env.OASDIFF_BIN;

enterHermeticEnv();

const { app } = await import('./index.js');
const { mcpTools, toolListing } = await import('./mcp/index.js');
const { buildApiContract, UNDECLARED_RESPONSE } = await import('./api-contract/openapi.js');
const { buildMcpContract } = await import('./api-contract/mcp-tools.js');
const { undeclaredSourceReads } = await import('./api-contract/request-reads.js');
const { deriveVersion, fetchOasdiff, measureChange, UNNUMBERED } = await import(
  './ecosystem/index.js'
);
const SRC = CORE;

const api = buildApiContract(app.routes, {
  title: 'forge-api',
  version: UNNUMBERED,
  description:
    'Every route packages/core/src/index.ts mounts, generated from the running app. A request part is described where a zod validator holds it, and `x-forge-validated` on each operation lists which parts those are. The generator refuses a route whose handlers read a body or a query no validator declares, so a part missing from that list is one the route does not read: a path parameter with no validator is any string, a body declared with rawBody() is not JSON and carries its media type and description only, and `x-forge-input: none` marks an operation that reads no input at all. `x-forge-query-closed` marks a read whose query refuses a key it does not take; every GET carries it, or carries `x-forge-query-open` naming why a third party chooses its keys. `x-forge-refinements` on a schema names each refine() by the message it refuses with; the predicate itself is not described. `x-forge-auth` lists, in the order they run, the gate middlewares mounted on the route, each defined under `x-forge-auth-gates`; an empty list means no gate middleware, and a handler may still check a credential of its own. Every 4XX and 5XX answers `application/problem+json` (`components.responses.Problem`); a success response is undeclared: ' +
    UNDECLARED_RESPONSE,
  'x-forge-generator': GENERATOR,
});

const ctx = { principal: { userId: 'api-contract' } };
const mcp = buildMcpContract(toolListing(mcpTools(ctx as never)), {
  contract: 'forge-mcp',
  version: UNNUMBERED,
  description: 'The MCP tools POST /mcp serves, as tools/list answers them, sorted by name.',
  generator: GENERATOR,
});

const refusals = [
  ...undeclaredSourceReads(SRC, resolve(SRC, '..', '..', '..')),
  ...api.refusals,
  ...mcp.refusals,
];
if (refusals.length > 0) {
  console.error(
    `api-contract: ${refusals.length} route(s) or tool(s) this generator cannot describe:`,
  );
  for (const r of refusals) console.error(`  ${r}`);
  process.exit(1);
}

// oasdiff is fetched only when the API contract moved: the pinned release, sha256-checked, into the
// cache `oasdiff:fetch` fills, unless the caller or the core image already holds it
async function ensureOasdiff(): Promise<void> {
  if (process.env.OASDIFF_BIN) return;
  process.env.OASDIFF_BIN =
    callerOasdiff ||
    (existsSync(IMAGE_OASDIFF)
      ? IMAGE_OASDIFF
      : await fetchOasdiff(join(CORE, 'node_modules', '.cache', 'oasdiff')));
}

type Doc = Record<string, unknown>;
type VersionField = { get: (d: Doc) => unknown; set: (d: Doc, v: string) => Doc };

const INFO_VERSION: VersionField = {
  get: (d) => (d.info as Doc | undefined)?.version,
  set: (d, v) => ({ ...d, info: { ...(d.info as Doc), version: v } }),
};
const TOP_VERSION: VersionField = { get: (d) => d.version, set: (d, v) => ({ ...d, version: v }) };

/** The document numbered after the one the base holds and the registry floor, and the line saying why. */
async function numbered(
  file: string,
  type: 'openapi' | 'mcp-tools',
  document: Doc,
  field: VersionField,
): Promise<{ document: Doc; line: string }> {
  const baseText = base.texts[file] ?? null;
  if (baseText === null) {
    console.error(
      `api-contract: ${base.basis} (${base.rev.slice(0, 12)}) holds no packages/core/contracts/${file}, so there is no version to number this one after.\n` +
        'Name the branch this lands on: GITHUB_BASE_REF=<branch> pnpm --filter @forge/core contracts:generate',
    );
    process.exit(2);
  }
  const previous = JSON.parse(baseText) as Doc;
  const was = field.get(previous);
  const floor = base.floors[file] ?? null;
  // a differ that cannot be had (no pinned oasdiff, a fetch that failed) could not run, exit 2, and
  // is never read as the route refusals exit 1 reports
  const derived = await deriveVersion(
    {
      type,
      base: {
        version: typeof was === 'string' ? was : null,
        text: canonicalJson(field.set(previous, UNNUMBERED)),
      },
      next: canonicalJson(field.set(document, UNNUMBERED)),
      floor: floor && {
        version: floor.version,
        text: canonicalJson(field.set(JSON.parse(floor.text) as Doc, UNNUMBERED)),
      },
    },
    async (t, a, b) => {
      if (t === 'openapi') await ensureOasdiff();
      return measureChange(t, a, b);
    },
  ).catch((err: unknown) => ({
    ok: false as const,
    refusal: `the differ could not run: ${err instanceof Error ? err.message : String(err)}`,
  }));
  if (!derived.ok) {
    console.error(`api-contract: ${file} cannot be numbered — ${derived.refusal}`);
    process.exit(2);
  }
  return {
    document: field.set(document, derived.version),
    line: `${file} ${derived.version}: ${derived.why}`,
  };
}

const numberedApi = await numbered(API_ARTIFACT, 'openapi', api.document, INFO_VERSION);
const numberedMcp = await numbered(MCP_ARTIFACT, 'mcp-tools', mcp.document, TOP_VERSION);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, API_ARTIFACT), canonicalJson(numberedApi.document));
writeFileSync(join(out, MCP_ARTIFACT), canonicalJson(numberedMcp.document));
console.log(
  `api-contract: ${api.operations} operation(s) · ${mcp.tools} tool(s) written to ${out}, numbered after ${base.basis} (${base.rev.slice(0, 12)})`,
);
console.log(`  ${numberedApi.line}`);
console.log(`  ${numberedMcp.line}`);
process.exit(0);
