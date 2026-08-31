/**
 * ISS-889 — the structural half of "one data plane", one level up from
 * `issues/one-create-path.test.ts`. That test bans a transport from writing two
 * specific tables; this one bans an MCP tool from holding a database handle at
 * all, which is the condition the issue states as its acceptance criterion.
 *
 * A behaviour test can show REST and MCP agree on the rows they return today.
 * Only a source scan shows that the next action added to a tool cannot quietly
 * open its own query beside the service the other transport calls.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLS = resolve(import.meta.dirname);

function toolSources(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(TOOLS)) {
    const full = join(TOOLS, entry);
    if (statSync(full).isDirectory()) continue;
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

function toolsImportingDb(): string[] {
  return toolSources()
    .filter((f) => /from '(\.\.\/)+db\/client\.js'/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(TOOLS, f))
    .sort();
}

describe('MCP tools reach the database through services (ISS-889)', () => {
  // cm:guard this list was 28 tools when ISS-889 opened and is empty because every one of them moved its queries into a service under its own domain. It is NOT an allowlist with nothing in it yet — there is no admission process for adding a name back. A tool that needs data needs a service, and the service is where the REST side finds it too.
  it('no MCP tool holds a database handle', () => {
    expect(
      toolsImportingDb(),
      'these MCP tools import db/client.js. Route the query through a service under its ' +
        'domain directory, the way issues/create-service.ts serves both transports — a query ' +
        'that lives in a tool is a second data plane the REST side cannot reach, and it drifts ' +
        'silently: measured on this repo, the two sides had already parted on which columns a ' +
        'session list returns, which statuses occupy a runner, and whether an apiKey collision ' +
        'is a taken slug.',
    ).toEqual([]);
  });

  it('finds the tools it claims to scan', () => {
    const sources = toolSources().map((f) => relative(TOOLS, f));
    expect(sources).toContain('forge-issues.ts');
    expect(sources.length).toBeGreaterThan(30);
  });
});
