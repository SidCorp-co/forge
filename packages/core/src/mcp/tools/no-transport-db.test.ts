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
