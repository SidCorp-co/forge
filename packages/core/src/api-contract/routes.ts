import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Context, Hono } from 'hono';
import { noQuery } from '../middleware/zod-validator.js';

/**
 * The directory the generator writes and the image ships: `packages/core/contracts` from `src/`,
 * `/app/contracts` from `dist/`. It is listed in package.json `files`, which is what `pnpm deploy`
 * copies into the image.
 */
export const CONTRACTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'contracts',
);

/** The IANA media type of an OpenAPI document in JSON, with the major.minor it is written in. */
export const OPENAPI_MEDIA_TYPE = 'application/vnd.oai.openapi+json;version=3.1';

type Served = { bytes: Buffer; etag: string };

/** The checked-in file, read once and kept: it is fixed for the life of the build that ships it. */
function servedFile(dir: string, file: string): () => Served {
  let kept: Served | null = null;
  return () => {
    if (kept) return kept;
    const bytes = readFileSync(resolve(dir, file));
    kept = { bytes, etag: `"sha256-${createHash('sha256').update(bytes).digest('hex')}"` };
    return kept;
  };
}

/** Whether `If-None-Match` names this tag: `*`, or one of its list, weak or strong (RFC 9110 §13.1.2). */
function matches(ifNoneMatch: string | undefined, tag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return (
    ifNoneMatch.trim() === '*' ||
    ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === tag)
  );
}

/**
 * The published contracts, byte for byte as committed, with no credential: they describe the
 * shape of every route and tool and the gates in front of them, never a row or a secret, and the
 * code they are generated from is the open-source repository itself. Each answer carries the
 * file's sha256 as its ETag, so a client revalidates with `If-None-Match` and gets a 304.
 */
export function publishedContractRoutes(dir: string = CONTRACTS_DIR): Hono {
  const openapi = servedFile(dir, 'forge-api.openapi.json');
  const mcpTools = servedFile(dir, 'forge-mcp.tools.json');
  // hono/etag answers its 304 with the ETag alone, and RFC 9110 §15.4.5 keeps Cache-Control on it
  const answer = (read: () => Served, type: string) => (c: Context) => {
    const { bytes, etag } = read();
    const headers = { etag, 'cache-control': 'public, max-age=300' };
    if (matches(c.req.header('if-none-match'), etag)) return c.body(null, 304, headers);
    return c.body(new Uint8Array(bytes), 200, { ...headers, 'content-type': type });
  };
  return new Hono()
    .get('/openapi.json', noQuery, answer(openapi, OPENAPI_MEDIA_TYPE))
    .get('/mcp-tools.json', noQuery, answer(mcpTools, 'application/json; charset=utf-8'));
}
