import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { PAT_UNGRANTABLE } from '../../auth/pat-permissions.js';
import { buildReference, type Reference } from '../document/build.js';
import { checkFlows, FLOWS } from '../surface/flows.js';
import { checkReference, describeFinding } from './check.js';

/**
 * The reference against the composed app: every route the app serves is an operation that states
 * its inputs, its answers and its access, and the document names every way it falls short.
 *
 * `REFERENCE_ONLY=<regex>` narrows what the findings are read for to the routes it matches, which is
 * how a change to one domain reads its own routes without wading through the rest. The gate runs
 * without it.
 */
const SRC = fileURLToPath(new URL('../..', import.meta.url));

function sourceText(): string {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts'))
    .map((file) => readFileSync(join(SRC, file), 'utf8'))
    .join('\n');
}

let reference: Reference;
let source: string;

beforeAll(async () => {
  const { app } = (await import('../../index.js')) as unknown as { app: Hono };
  reference = await buildReference(app, { version: 'test' });
  source = sourceText();
}, 120_000);

describe('the API reference of the composed app', () => {
  it('reads a composed app, not an empty one', () => {
    expect(reference.routes.length).toBeGreaterThan(500);
  });

  it('is complete and consistent with the routes: no finding names a route', () => {
    const only = process.env.REFERENCE_ONLY ? new RegExp(process.env.REFERENCE_ONLY) : null;
    const findings = checkReference({ reference, source }).filter(
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

  it('serves every public exclusion as an operation that needs no credential', () => {
    const publics = Object.entries(PAT_UNGRANTABLE).filter(([, e]) => e.admits === 'public');
    const operations = Object.values(reference.document.paths).flatMap((methods) =>
      Object.values(methods),
    );
    const open = operations.filter((op) => Array.isArray(op.security) && op.security.length === 0);
    expect(open.length).toBeGreaterThanOrEqual(publics.length);
  });

  it('draws only flows whose every step is an operation of the document', () => {
    expect(checkFlows(reference.document, FLOWS)).toEqual([]);
  });

  it('is valid JSON a client can parse back to the same document', () => {
    expect(JSON.parse(JSON.stringify(reference.document))).toEqual(reference.document);
  });
});
