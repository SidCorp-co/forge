import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { patUngrantableFor } from '../../auth/pat-permissions.js';
import { buildReference, openApiPath, type Reference } from '../document/build.js';
import { checkFlows, FLOWS } from '../surface/flows.js';
import { checkReference, describeFinding } from './check.js';
import { stringsWrittenOutsideDeclarations } from './written-codes.fixture.js';

/**
 * The reference against the composed app: every route the app serves is an operation that states
 * its inputs, its answers and its access, and the document names every way it falls short.
 *
 * `REFERENCE_ONLY=<regex>` narrows what the findings are read for to the routes it matches, which is
 * how a change to one domain reads its own routes without wading through the rest. The gate runs
 * without it.
 */
const SRC = fileURLToPath(new URL('../..', import.meta.url));

function sourceTexts(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
    .map((file) => readFileSync(join(SRC, file), 'utf8'));
}

let reference: Reference;
let written: Set<string>;

beforeAll(async () => {
  const { app } = (await import('../../index.js')) as unknown as { app: Hono };
  reference = await buildReference(app, { version: 'test' });
  written = stringsWrittenOutsideDeclarations(sourceTexts());
}, 120_000);

describe('the API reference of the composed app', () => {
  it('reads a composed app, not an empty one', () => {
    expect(reference.routes.length).toBeGreaterThan(500);
  });

  it('is complete and consistent with the routes: no finding names a route', () => {
    const only = process.env.REFERENCE_ONLY ? new RegExp(process.env.REFERENCE_ONLY) : null;
    const findings = checkReference({ reference, written }).filter(
      (f) => !only || only.test(f.route),
    );
    if (process.env.REFERENCE_DUMP)
      writeFileSync(process.env.REFERENCE_DUMP, JSON.stringify(findings, null, 1));
    expect(
      findings.map(describeFinding),
      'each finding is a route (or the document) falling short of what the reference promises: ' +
        'fix the route, never the check',
    ).toEqual([]);
  });

  it('asks for a bearer on exactly the routes whose gates read one, and on the MCP door', () => {
    const wrong = reference.routes.flatMap((entry) => {
      const operation = reference.document.paths[openApiPath(entry.path)]?.[
        entry.method.toLowerCase()
      ] as { security?: unknown[] } | undefined;
      const asks = Array.isArray(operation?.security) && operation.security.length > 0;
      const door = patUngrantableFor(entry.path, entry.method)?.admits;
      const wanted =
        door === 'public' || door === 'ticket' || door === 'signature'
          ? false
          : door === 'mcp' || entry.takesBearer;
      return asks === wanted
        ? []
        : [`${entry.key} is documented ${asks ? 'with' : 'without'} a bearer`];
    });
    expect(wrong).toEqual([]);
  });

  it('documents with no bearer each route whose handler was read to take none, behind any door', () => {
    // Each of these routes was read in its source: its credential is a body, a cookie, a pairing
    // code or a token in the path, never an Authorization header.
    const bearerless = [
      'POST /api/devices/login/init',
      'GET /api/devices/login/poll',
      'POST /api/devices/pair',
      'POST /api/auth/local',
      'POST /api/auth/register',
      'POST /api/auth/refresh',
      'GET /api/invitations/:token',
      'GET /api/org-invitations/:token',
    ];
    const bearer = ['POST /api/devices/heartbeat', 'GET /api/devices/me/pool', 'POST /api/pat'];
    const asks = (key: string) => {
      const entry = reference.routes.find((r) => r.key === key);
      if (!entry) throw new Error(`the composed app serves no ${key}`);
      const operation = reference.document.paths[openApiPath(entry.path)]?.[
        entry.method.toLowerCase()
      ] as { security?: unknown[] };
      return (operation.security ?? []).length > 0;
    };
    expect(bearerless.filter(asks)).toEqual([]);
    expect(bearer.filter((key) => !asks(key))).toEqual([]);
  });

  it('shows, in the words an operation is read by, the permission or the door the document carries', () => {
    const missing = reference.routes.flatMap((entry) => {
      const operation = reference.document.paths[openApiPath(entry.path)]?.[
        entry.method.toLowerCase()
      ] as { description?: string; 'x-forge-access'?: { permission?: string; door: string } };
      const access = operation['x-forge-access'];
      if (!access) return [`${entry.key} carries no access`];
      const shown = access.permission
        ? `**Permission:** \`${access.permission}\``
        : `**Door:** \`${access.door}\``;
      return operation.description?.startsWith(shown) ? [] : [`${entry.key} does not say ${shown}`];
    });
    expect(missing).toEqual([]);
  });

  it('draws only flows whose every step is an operation of the document', () => {
    expect(checkFlows(reference.document, FLOWS)).toEqual([]);
  });

  it('is valid JSON a client can parse back to the same document', () => {
    expect(JSON.parse(JSON.stringify(reference.document))).toEqual(reference.document);
  });
});
