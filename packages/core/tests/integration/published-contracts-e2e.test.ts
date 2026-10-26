/**
 * Forge's own API contract and MCP tool list, read the way a client that has never signed in reads
 * them: through the whole app, its middleware, CORS and error handler included, with no credential.
 * What answers must be the committed file byte for byte, since that file is what
 * check-api-contracts holds to the code and what a consumer pins by its version.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/index.js';

const CONTRACTS = resolve(import.meta.dirname, '..', '..', 'contracts');

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://forge.test${path}`, { headers }));
}

describe('GET /api/openapi.json and GET /api/mcp-tools.json', () => {
  for (const [path, file, type] of [
    ['/api/openapi.json', 'forge-api.openapi.json', 'application/vnd.oai.openapi+json;version=3.1'],
    ['/api/mcp-tools.json', 'forge-mcp.tools.json', 'application/json; charset=utf-8'],
  ] as const) {
    it(`${path} answers packages/core/contracts/${file} byte for byte, with no credential`, async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      const served = Buffer.from(await res.arrayBuffer());
      const committed = readFileSync(join(CONTRACTS, file));
      expect(
        served.equals(committed),
        `served-is-committed: ${path} is not packages/core/contracts/${file} byte for byte`,
      ).toBe(true);
      const again = await get(path, { 'if-none-match': res.headers.get('etag') ?? '' });
      expect(again.status).toBe(304);
    });
  }

  it('describes both routes in the contract it serves, as reading no input behind no gate', async () => {
    const doc = (await (await get('/api/openapi.json')).json()) as {
      info: { version: string };
      paths: Record<string, { get?: Record<string, unknown> }>;
    };
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const path of ['/api/openapi.json', '/api/mcp-tools.json']) {
      expect(doc.paths[path]?.get?.['x-forge-auth'], path).toEqual([]);
      expect(doc.paths[path]?.get?.['x-forge-input'], path).toBe('none');
    }
  });
});
