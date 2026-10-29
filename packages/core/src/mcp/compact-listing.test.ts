// ISS-768 r2: ChatGPT's connector listed the full 56 KB catalog and reported "action discovery
// failed"; its limit is the whole catalog under about 5,000 tokens. It is served a compact listing:
// at most 16 KB, each tool a short summary and an input every importer reads.
//
// @direct-test-of packages/core/src/mcp/compact-listing.ts

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { PAT_GRANT_EPOCH } from '../credentials/pat-permissions.js';
import type { McpContext } from '../lib/tool.js';
import type { PrincipalVars } from '../middleware/require-pat.js';
import { COMPACT_BUDGET_BYTES, COMPACT_DESCRIPTIONS, compactListing } from './compact-listing.js';
import { MCP_TOOLS } from './registry.js';
import { mcpTools, toolListing } from './server.js';

const principal = {
  kind: 'pat',
  agency: 'agent',
  agentUserId: null,
  userId: '00000000-0000-4000-8000-000000000768',
  tokenId: 'tok-768',
  scopes: ['read', 'write'],
  projectIds: null,
  permissions: ['*'],
  grantEpoch: PAT_GRANT_EPOCH,
  boundProjectId: null,
  deviceId: null,
  onBehalfOf: null,
} as unknown as PrincipalVars['principal'];

const listing = compactListing(
  toolListing(mcpTools({ principal, projectSlug: null } as unknown as McpContext)),
);
const BA = [
  'forge_requirements',
  'project_feedback',
  'forge_questions',
  'forge_feedback',
  'forge_design',
  'forge_releases',
  'forge_issues',
];

/** Every property description in a schema, however deep. */
function descriptions(schema: unknown, out: string[] = []): string[] {
  if (Array.isArray(schema)) for (const s of schema) descriptions(s, out);
  else if (schema && typeof schema === 'object') {
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'description' && typeof v === 'string') out.push(v);
      else if (k !== 'enum' && k !== 'default') descriptions(v, out);
    }
  }
  return out;
}

describe("ChatGPT's compact listing", () => {
  it(`fits ${COMPACT_BUDGET_BYTES} bytes as tools/list answers it`, () => {
    expect(Buffer.byteLength(JSON.stringify({ tools: listing }))).toBeLessThanOrEqual(
      COMPACT_BUDGET_BYTES,
    );
  });

  it('keeps every BA tool, and lists no tool the registry does not serve', () => {
    const names = listing.map((t) => t.name);
    for (const ba of BA) expect(names).toContain(ba);
    for (const n of names) expect(Object.keys(MCP_TOOLS)).toContain(n);
  });

  it('has a summary of at most 400 characters for every registry tool', () => {
    expect(Object.keys(COMPACT_DESCRIPTIONS).sort()).toEqual(Object.keys(MCP_TOOLS).sort());
    for (const [name, text] of Object.entries(COMPACT_DESCRIPTIONS))
      expect(text.length, name).toBeLessThanOrEqual(400);
  });

  it.each(listing.map((t) => [t.name, t] as const))(
    '%s: a valid strict JSON Schema object, no noise keyword, no property description over 80',
    (_name, tool) => {
      const strict = new Ajv2020({ strict: true, strictRequired: true, validateFormats: false });
      expect(strict.validateSchema(tool.inputSchema), JSON.stringify(strict.errors)).toBe(true);
      expect(() => strict.compile(tool.inputSchema)).not.toThrow();
      expect(tool.inputSchema.type).toBe('object');
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(
        /"(pattern|format|maxLength|minLength|maxItems|minItems|\$schema|propertyNames|const)":/,
      );
      for (const d of descriptions(tool.inputSchema)) expect(d.length).toBeLessThanOrEqual(80);
    },
  );
});
