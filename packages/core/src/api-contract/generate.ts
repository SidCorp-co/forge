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

const api = buildApiContract(app.routes, {
  title: 'forge-api',
  version: 'unversioned',
  description:
    'Every route packages/core/src/index.ts mounts, generated from the running app. A request part is described only where a zod validator holds it, and `x-forge-validated` on each operation lists which parts those are: a part missing from that list is not described, which is not the same as absent. Responses are undeclared throughout: ' +
    UNDECLARED_RESPONSE,
  'x-forge-generator': GENERATOR,
});

const ctx = { principal: { userId: 'api-contract' }, deprecations: new Set<string>() };
const mcp = buildMcpContract(toolListing(mcpTools(ctx as never)), {
  contract: 'forge-mcp',
  description: 'The MCP tools POST /mcp serves, as tools/list answers them, sorted by name.',
  generator: GENERATOR,
});

const refusals = [...api.refusals, ...mcp.refusals];
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
