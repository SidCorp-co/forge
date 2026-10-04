import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './canonical.js';
import { enterHermeticEnv } from './hermetic-env.js';

const GENERATOR = 'packages/core/src/api-contract/generate.ts';
const DEFAULT_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts');
export const API_ARTIFACT = 'forge-api.openapi.json';
export const MCP_ARTIFACT = 'forge-mcp.tools.json';

function outDir(argv: string[]): string {
  const i = argv.indexOf('--out');
  if (i === -1) return DEFAULT_OUT;
  const dir = argv[i + 1];
  if (dir === undefined || dir.startsWith('--')) {
    console.error('api-contract: --out needs a directory');
    process.exit(2);
  }
  return resolve(dir);
}

enterHermeticEnv();

const out = outDir(process.argv.slice(2));
const { app } = await import('../index.js');
const { mcpTools, toolListing } = await import('../mcp/server.js');
const { buildApiContract, UNDECLARED_RESPONSE } = await import('./openapi.js');
const { buildMcpContract } = await import('./mcp-tools.js');
const { undeclaredSourceReads } = await import('./request-reads.js');
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const api = buildApiContract(app.routes, {
  title: 'forge-api',
  version: 'unversioned',
  description:
    'Every route packages/core/src/index.ts mounts, generated from the running app. A request part is described where a zod validator holds it, and `x-forge-validated` on each operation lists which parts those are. The generator refuses a route whose handlers read a body or a query no validator declares, so a part missing from that list is one the route does not read: a path parameter with no validator is any string, a body declared with rawBody() is not JSON and carries its media type and description only, and `x-forge-input: none` marks an operation that reads no input at all. `x-forge-refinements` on a schema names each refine() by the message it refuses with; the predicate itself is not described. `x-forge-auth` lists, in the order they run, the gate middlewares mounted on the route, each defined under `x-forge-auth-gates`; an empty list means no gate middleware, and a handler may still check a credential of its own. Responses are undeclared throughout: ' +
    UNDECLARED_RESPONSE,
  'x-forge-generator': GENERATOR,
});

const ctx = { principal: { userId: 'api-contract' } };
const mcp = buildMcpContract(toolListing(mcpTools(ctx as never)), {
  contract: 'forge-mcp',
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

mkdirSync(out, { recursive: true });
writeFileSync(join(out, API_ARTIFACT), canonicalJson(api.document));
writeFileSync(join(out, MCP_ARTIFACT), canonicalJson(mcp.document));
console.log(
  `api-contract: ${api.operations} operation(s) · ${mcp.tools} tool(s) written to ${out}`,
);
process.exit(0);
