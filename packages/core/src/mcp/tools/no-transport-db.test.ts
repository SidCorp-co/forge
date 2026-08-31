/**
 * ISS-889 — the structural half of "one data plane", one level up from
 * `issues/one-create-path.test.ts`. That test bans a transport from writing two
 * specific tables; this one bans an MCP tool from holding a database handle at
 * all, which is the condition the issue states as its acceptance criterion.
 *
 * A behaviour test can show REST and MCP agree on the rows they return today.
 * Only a source scan shows that the next action added to a tool cannot quietly
 * open its own query beside the service the other eleven call.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const TOOLS = resolve(import.meta.dirname);

/**
 * Tools still holding their own `db` handle. ISS-889 empties this list one
 * domain at a time; `forge-issues.ts` was the first out. Removing a name is the
 * deliverable — never add one back, and never add a NEW tool to it.
 */
const PENDING_TOOLS = [
  'forge-agent-sessions.ts',
  'forge-collaborators.ts',
  'forge-comments.ts',
  'forge-config.ts',
  'forge-feedback.ts',
  'forge-guide.ts',
  'forge-jobs.ts',
  'forge-metrics.ts',
  'forge-ops-health.ts',
  'forge-phase.ts',
  'forge-pipeline-runs.ts',
  'forge-pm-dispatch.ts',
  'forge-pm-graph.ts',
  'forge-pm-runner-load.ts',
  'forge-pm-snapshot.ts',
  'forge-pm-write-decision.ts',
  'forge-projects.ts',
  'forge-runners.ts',
  'forge-schedules.ts',
  'forge-step-start.ts',
  'forge-uploads.ts',
  'forge-ux-findings.ts',
  'lib.ts',
];

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
  it('forge-issues holds no database handle', () => {
    expect(
      toolsImportingDb(),
      'forge-issues.ts imports db/client.js again. Every one of its twelve actions goes ' +
        'through issues/*-service.ts or tasks/task-service.ts; a new action that opens its own ' +
        'query is the second data plane ISS-889 exists to remove.',
    ).not.toContain('forge-issues.ts');
  });

  it('no tool outside the declared backlog holds one', () => {
    const unexpected = toolsImportingDb().filter((f) => !PENDING_TOOLS.includes(f));
    expect(
      unexpected,
      'these MCP tools query the database directly and are not on the ISS-889 backlog. ' +
        'Route the write through a service under its domain directory, the way ' +
        `issues/create-service.ts serves both transports: ${unexpected.join(', ')}`,
    ).toEqual([]);
  });

  it('the backlog names only tools that still hold one', () => {
    const importing = new Set(toolsImportingDb());
    const stale = PENDING_TOOLS.filter((f) => !importing.has(f));
    expect(
      stale,
      'these tools no longer import db/client.js — take them off PENDING_TOOLS so the list ' +
        `keeps measuring the real remaining work: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
