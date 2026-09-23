/**
 * ISS-1153 — an App created from Forge's manifest can do everything Forge's code asks of it.
 *
 * The manifest asked for six permissions and `readProtection` needed a seventh, so a merge died on
 * a 403 while every health signal said `ok`. The gap was not the permission; it was that nothing
 * compared the two lists. This is the comparison.
 *
 * The required side is derived from the AST, not from the text: a call is found by what it CALLS,
 * so the spelling of its arguments can make it unreadable but never invisible. Three rounds of
 * regex enumeration each closed the shapes the round before had named and left the class open —
 * the shapes under "however the call is written" are the ones that class was last demonstrated by.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  auditEvents,
  auditPermissions,
  callsInTree,
  callsToPrice,
  collectGitHubCalls,
  DECLARATION_FILE,
  type FoundCall,
  GITHUB_DIR,
  handledEvents,
  key,
  manifest,
  REQUEST_HELPERS,
  sourceFiles,
  undeclaredHelperFiles,
  undeclaredPathLiterals,
  unreadableRequests,
} from './app-permissions.fixture.js';
import { GITHUB_ENDPOINTS, requiredAppPermissions } from './app-permissions.js';
import {
  CLIENT_TRANSPORTS,
  NO_METHOD,
  TRANSPORT_ADDED,
  TRANSPORT_PROPERTY,
  TRANSPORT_SWAPPED,
  UNRESOLVED,
} from './app-permissions-plants.fixture.js';

const orphansIn = (file: string) => {
  const declared = new Set(GITHUB_ENDPOINTS.map((e) => key(e.method, e.path)));
  return callsToPrice(collectGitHubCalls(file))
    .filter((c) => !c.unresolved && !declared.has(key(c.method, c.path)))
    .map((c) => `${c.file}:${c.line} — ${key(c.method, c.path)}`);
};

const only = (calls: FoundCall[]): FoundCall => {
  expect(calls).toHaveLength(1);
  return calls[0] as FoundCall;
};

describe('the manifest requests what Forge’s code needs (ISS-1153)', () => {
  it('resolves every GitHub path expression in the integration', () => {
    const calls = callsInTree();
    const stuck = callsToPrice(calls).filter((c) => c.unresolved);
    expect(
      stuck.map((c) => `${c.file}:${c.line} — ${c.unresolved}`),
      'a call this checker cannot read is a call it cannot price; declare the path plainly or teach the resolver the shape',
    ).toEqual([]);
    expect(calls.length).toBeGreaterThan(20);
  });

  it('names the file, the line and the expression of a path it cannot resolve', () => {
    const found = only(collectGitHubCalls(UNRESOLVED));
    expect(found.unresolved).toContain('somewhereElse(client)');
    expect(found.file).toBe(UNRESOLVED);
    expect(found.line).toBe(7);
  });

  it('names the call whose HTTP method it cannot read', () => {
    expect(only(collectGitHubCalls(NO_METHOD)).unresolved).toContain('names no HTTP method');
  });

  it('holds an endpoint record for every call the source makes', () => {
    const orphans = sourceFiles().flatMap((f) => orphansIn(f));
    expect(
      orphans,
      'declare it in app-permissions.ts with the permission GitHub documents for it',
    ).toEqual([]);
  });

  it('holds no endpoint record the source no longer calls', () => {
    const made = new Set(
      callsToPrice(callsInTree())
        .filter((c) => !c.unresolved)
        .map((c) => key(c.method, c.path)),
    );
    const stale = GITHUB_ENDPOINTS.map((e) => key(e.method, e.path)).filter((k) => !made.has(k));
    expect(
      stale,
      'the call site is gone; drop the row rather than keeping the permission it buys',
    ).toEqual([]);
  });

  it('prices every GitHub path written in these sources, whatever carries it', () => {
    expect(
      undeclaredPathLiterals(),
      'a GitHub path is written here that no endpoint record accounts for',
    ).toEqual([]);
  });

  it('declares every file that makes a request the checker cannot read a path out of', () => {
    expect(
      undeclaredHelperFiles(),
      'this file calls fetch with a URL the checker cannot read; name the path at the call site, or declare the helper in REQUEST_HELPERS',
    ).toEqual([]);
  });

  it('holds exactly the transport expressions each of those files declares', () => {
    const wrong = Object.entries(REQUEST_HELPERS)
      .map(([file, declared]) => {
        if (!sourceFiles().includes(file)) return `${file} — declared, and no longer a source file`;
        const found = unreadableRequests(file);
        const held = found.map((r) => r.raw).sort();
        const want = [...declared.transports].sort();
        if (held.join('\u0000') === want.join('\u0000')) return null;
        return `${file} — declares [${want.join(', ')}], holds [${held.join(', ')}] at line(s) ${found.map((r) => r.line).join(', ')}`;
      })
      .filter((m): m is string => m !== null);
    expect(
      wrong,
      'a request the checker cannot read a path out of is a GitHub call nobody prices; name its path at the call site, or list the expression here and say what the transport is',
    ).toEqual([]);
  });

  it('names a transport ADDED to a file that already declares its own', () => {
    const found = unreadableRequests(TRANSPORT_ADDED);
    expect(found.map((r) => r.raw).sort()).not.toEqual([...CLIENT_TRANSPORTS].sort());
    expect(found.map((r) => r.raw)).toContain('computedGitHubUrl');
  });

  it('names a transport SUBSTITUTED for one a file declares, with the count unchanged', () => {
    const found = unreadableRequests(TRANSPORT_SWAPPED);
    expect(found).toHaveLength(CLIENT_TRANSPORTS.length);
    expect(found.map((r) => r.raw).sort()).not.toEqual([...CLIENT_TRANSPORTS].sort());
  });

  it('names a transport reached through a property or an operator', () => {
    expect(unreadableRequests(TRANSPORT_PROPERTY).map((r) => r.raw)).toEqual([
      'computedGitHubUrl',
      'base + path',
    ]);
  });

  it('the declaration file makes no GitHub call of its own', () => {
    expect(collectGitHubCalls(DECLARATION_FILE)).toEqual([]);
  });

  it('requests every permission the tables require, at the level they require', () => {
    expect(auditPermissions(manifest().default_permissions, requiredAppPermissions())).toEqual([]);
  });

  it('requests administration: read, which reading branch protection needs', () => {
    expect(manifest().default_permissions.administration).toBe('read');
  });

  it('goes red naming the permission when the manifest drops one the code needs', () => {
    const { administration: _dropped, ...without } = manifest().default_permissions;
    const faults = auditPermissions(without, requiredAppPermissions());
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      kind: 'missing',
      permission: 'administration',
      required: 'read',
    });
    expect((faults[0] as { needers: string[] }).needers).toContain(
      'GET /repos/:p/:p/branches/:p/protection',
    );
  });

  it('goes red naming the level when the manifest requests one below what a call needs', () => {
    const weakened = { ...manifest().default_permissions, contents: 'read' };
    expect(auditPermissions(weakened, requiredAppPermissions())).toEqual([
      expect.objectContaining({
        kind: 'below',
        permission: 'contents',
        required: 'write',
        requested: 'read',
      }),
    ]);
  });

  it('goes red naming the permission the manifest asks for and nothing needs', () => {
    const over = { ...manifest().default_permissions, packages: 'write' };
    expect(auditPermissions(over, requiredAppPermissions())).toEqual([
      { kind: 'surplus', permission: 'packages', requested: 'write' },
    ]);
  });

  it('subscribes to exactly the events it declares, and handles each one', () => {
    const m = manifest();
    expect(auditEvents(m.default_events, handledEvents(), m.default_permissions)).toEqual([]);
  });

  it('goes red naming an event the manifest subscribes to and no table declares', () => {
    const m = manifest();
    expect(
      auditEvents([...m.default_events, 'release'], handledEvents(), m.default_permissions),
    ).toEqual([{ kind: 'undeclared', event: 'release' }]);
  });

  it('goes red naming an event no handler in this repository acts on', () => {
    const m = manifest();
    const handled = new Set([...handledEvents()].filter((e) => e !== 'push'));
    expect(auditEvents(m.default_events, handled, m.default_permissions)).toEqual([
      { kind: 'unhandled', event: 'push' },
    ]);
  });

  it('goes red naming the event whose subscription permission is not requested', () => {
    const m = manifest();
    const { actions: _gone, ...without } = m.default_permissions;
    expect(auditEvents(m.default_events, handledEvents(), without)).toEqual([
      { kind: 'ungranted', event: 'workflow_run', required: 'read' },
    ]);
  });

  it('holds the lockstep annotation on both sides of the pair', () => {
    const read = (f: string) => readFileSync(join(GITHUB_DIR, f), 'utf8');
    expect(read('app-permissions.ts')).toContain(
      'cm:edge lockstep -> packages/core/src/integrations/github/connect.ts',
    );
    expect(read('connect.ts')).toContain(
      'cm:edge lockstep -> packages/core/src/integrations/github/app-permissions.ts',
    );
  });
});
