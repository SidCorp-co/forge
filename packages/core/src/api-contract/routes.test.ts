import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONTRACTS_DIR, OPENAPI_MEDIA_TYPE, publishedContractRoutes } from './routes.js';

const CORE = resolve(import.meta.dirname, '..', '..');
const COMMITTED = join(CORE, 'contracts');
const ROUTES = [
  { path: '/openapi.json', file: 'forge-api.openapi.json', type: OPENAPI_MEDIA_TYPE },
  {
    path: '/mcp-tools.json',
    file: 'forge-mcp.tools.json',
    type: 'application/json; charset=utf-8',
  },
];

/** Null where the answer is the committed file byte for byte, else the rule it breaks. */
async function servedDifference(res: Response, file: string): Promise<string | null> {
  const served = Buffer.from(await res.arrayBuffer());
  const committed = readFileSync(join(COMMITTED, file));
  if (served.equals(committed)) return null;
  return `served-is-committed: the answer is not packages/core/contracts/${file} byte for byte (${served.length} bytes served, ${committed.length} committed)`;
}

const scratch = mkdtempSync(join(tmpdir(), 'published-contracts-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the published contracts, served with no credential', () => {
  const routes = publishedContractRoutes();

  for (const { path, file, type } of ROUTES) {
    it(`GET ${path} answers packages/core/contracts/${file} byte for byte, as ${type}`, async () => {
      const res = await routes.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      const sha = createHash('sha256')
        .update(readFileSync(join(COMMITTED, file)))
        .digest('hex');
      expect(res.headers.get('etag')).toBe(`"sha256-${sha}"`);
      expect(await servedDifference(res, file)).toBeNull();
    });
  }

  it('answers a client holding the same tag 304 with no body, keeping Cache-Control', async () => {
    const tag = (await routes.request('/openapi.json')).headers.get('etag') ?? '';
    for (const ifNoneMatch of [tag, `W/${tag}`, `"other", ${tag}`, '*']) {
      const res = await routes.request('/openapi.json', {
        headers: { 'if-none-match': ifNoneMatch },
      });
      expect(res.status, ifNoneMatch).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('etag')).toBe(tag);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    }
  });

  it('answers a client holding another tag the whole document', async () => {
    const res = await routes.request('/openapi.json', {
      headers: { 'if-none-match': '"sha256-0000"' },
    });
    expect(res.status).toBe(200);
    expect(await servedDifference(res, 'forge-api.openapi.json')).toBeNull();
  });

  it('serves the version the generator wrote, for a consumer to pin', async () => {
    const api = (await (await routes.request('/openapi.json')).json()) as {
      info: { version: string };
    };
    const mcp = (await (await routes.request('/mcp-tools.json')).json()) as { version: string };
    expect(api.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mcp.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('a served source that is not the committed file', () => {
  it('is named by the rule it breaks: one byte changed in what is served goes red', async () => {
    for (const { file } of ROUTES) copyFileSync(join(COMMITTED, file), join(scratch, file));
    const text = readFileSync(join(scratch, 'forge-api.openapi.json'), 'utf8');
    writeFileSync(
      join(scratch, 'forge-api.openapi.json'),
      text.replace('"forge-api"', '"forge-apj"'),
    );
    const res = await publishedContractRoutes(scratch).request('/openapi.json');
    expect(await servedDifference(res, 'forge-api.openapi.json')).toMatch(
      /^served-is-committed: the answer is not packages\/core\/contracts\/forge-api\.openapi\.json byte for byte/,
    );
  });
});

describe('the directory the routes read', () => {
  it('is the committed contracts directory, which package.json `files` ships into the image', () => {
    expect(CONTRACTS_DIR).toBe(COMMITTED);
    const pkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain(relative(CORE, CONTRACTS_DIR));
  });
});
