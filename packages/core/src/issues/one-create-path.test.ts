/**
 * ISS-889 — the structural half of "one data plane". Behaviour tests can show
 * that REST and MCP agree today; only a source scan shows that a third caller
 * cannot quietly open its own path to the table tomorrow.
 *
 * This is the assertion that would have caught the drift the issue was filed
 * about: two transports each holding their own `insert(issues)`, diverging on
 * detector-key, labels-by-name, relations and transactionality for months.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..');

/**
 * Modules permitted to write the `issues` table directly. Each is a domain
 * writer, not a transport: a caller reaches them, they do not answer a request.
 */
const ISSUE_INSERT_ALLOWLIST = ['issues/create-service.ts', 'memory/consolidation.ts'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

function filesInserting(table: string): string[] {
  return sourceFiles(SRC)
    .filter((f) => new RegExp(`\\.insert\\(${table}\\)`).test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f))
    .sort();
}

/** A transport answers a request; it must delegate the write, never own it. */
function isTransport(file: string): boolean {
  return file.startsWith('mcp/tools/') || file.endsWith('routes.ts');
}

describe('one create path for issues (ISS-889)', () => {
  it('no transport writes the issues table directly', () => {
    const offenders = filesInserting('issues').filter(isTransport);
    expect(
      offenders,
      `these transports insert into \`issues\` themselves instead of calling createIssue() ` +
        `in issues/create-service.ts. Two create paths is exactly the drift ISS-889 removed: ` +
        `${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('only the declared domain writers insert into issues', () => {
    expect(
      filesInserting('issues'),
      'a new module writes the issues table. If it is a genuine domain writer, add it to ' +
        'ISSUE_INSERT_ALLOWLIST and say why in the diff; if it is a caller, route it through ' +
        'createIssue() instead.',
    ).toEqual([...ISSUE_INSERT_ALLOWLIST].sort());
  });

  it('no transport writes the issue_dependencies table directly', () => {
    const offenders = filesInserting('issueDependencies').filter(isTransport);
    expect(
      offenders,
      `these transports insert dependency edges themselves instead of calling ` +
        `setIssueDependency() in issues/dependency-service.ts. The REST copy silently dropped ` +
        `validUntil/reason on conflict, so an edge declared there could not be retracted: ` +
        `${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
