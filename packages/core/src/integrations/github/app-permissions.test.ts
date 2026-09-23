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
  undeclaredPathsIn,
  unreadableRequests,
} from './app-permissions.fixture.js';
import {
  appPermissionsPageUrl,
  describeShortfall,
  GITHUB_ENDPOINTS,
  installationShortfall,
  requiredAppPermissions,
} from './app-permissions.js';
import {
  ASSIGNED_ARGS,
  BARE_GET,
  CLIENT_TRANSPORTS,
  CONCATENATED,
  DECLARATIONS_ONLY,
  GITHUB_JSON,
  NO_METHOD,
  READABLE_GET,
  REAL_UNDECLARED_PATH,
  RETURNED_ARGS,
  SHORTHAND,
  TRAILING_COMMA,
  TRANSPORT_ADDED,
  TRANSPORT_PROPERTY,
  TRANSPORT_SWAPPED,
  UNRESOLVED,
  UNTYPED_RECEIVER,
  VARIABLE_PATH,
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

describe('a call is found by what it calls, however it is written (ISS-1153)', () => {
  it('names the call whose path is a variable', () => {
    const found = only(collectGitHubCalls(VARIABLE_PATH));
    expect(found.unresolved).toContain('endpoint');
    expect(found.line).toBe(5);
  });

  it('names the call whose path is concatenated onto a literal', () => {
    const found = only(collectGitHubCalls(CONCATENATED));
    expect(found.unresolved).toContain("prefix + '/merge'");
    expect(found.line).toBe(5);
  });

  it('names a bare identifier passed straight to client.get', () => {
    const found = only(collectGitHubCalls(BARE_GET));
    expect(found.method).toBe('GET');
    expect(found.unresolved).toContain('endpoint');
    expect(found.line).toBe(4);
  });

  it('still prices a client.get call whose template it CAN read', () => {
    const found = only(collectGitHubCalls(READABLE_GET));
    expect(key(found.method, found.path)).toBe('GET /repos/:p/:p/pulls');
    expect(found.unresolved).toBeNull();
  });

  it("does not fold a formatter's trailing comma into the argument it names", () => {
    expect(only(collectGitHubCalls(TRAILING_COMMA)).raw).toBe('endpoint');
  });

  it('reads a type annotation and a type alias as declarations, never as calls', () => {
    expect(collectGitHubCalls(DECLARATIONS_ONLY)).toEqual([]);
  });

  it('names a bare identifier passed as the URL argument to a transport function', () => {
    const found = only(collectGitHubCalls(GITHUB_JSON).filter((c) => c.kind === 'path'));
    expect(found.unresolved).toContain('someUrl');
    expect(found.line).toBe(6);
  });

  it("reads a request helper's own signature as a declaration, never as a request", () => {
    expect(unreadableRequests(GITHUB_JSON).map((r) => r.raw)).toEqual(['url']);
  });

  it('names a path built into an object assigned before the call that carries it', () => {
    const found = only(collectGitHubCalls(ASSIGNED_ARGS));
    expect(found.unresolved).toContain('somewhereElse(client)');
    expect(found.line).toBe(4);
  });

  it('names a path carried by a SHORTHAND property, which no colon marks', () => {
    const found = only(collectGitHubCalls(SHORTHAND));
    expect(found.unresolved).toContain('queuePath(client)');
    expect(found.file).toBe(SHORTHAND);
  });

  it('names a path inside an argument object a HELPER returned', () => {
    const found = only(collectGitHubCalls(RETURNED_ARGS));
    expect(found.unresolved).toContain('queuePath(client)');
    expect(found.file).toBe(RETURNED_ARGS);
  });

  it('prices a REAL path a shorthand property carries, rather than passing over it', () => {
    const found = only(collectGitHubCalls(REAL_UNDECLARED_PATH));
    expect(found.unresolved).toBeNull();
    expect(key(found.method, found.path)).toBe('GET /repos/:p/:p/merge-queue');
    expect(orphansIn(REAL_UNDECLARED_PATH)).toHaveLength(1);
  });

  it('refuses a transport reached through a receiver it cannot type, rather than skipping it', () => {
    const found = only(collectGitHubCalls(UNTYPED_RECEIVER));
    expect(found.unresolved).toContain('publish is a transport');
    expect(found.unresolved).toContain('anything');
  });

  it('names that same path in the sweep over what is written, not only at the call', () => {
    expect(undeclaredPathsIn(REAL_UNDECLARED_PATH).join(' ')).toContain('/repos/:p/:p/merge-queue');
  });
});

describe('what an installation is short of (ISS-1153)', () => {
  const granted = Object.fromEntries(requiredAppPermissions());

  it('finds nothing short in an installation granting everything', () => {
    expect(installationShortfall(granted)).toEqual([]);
  });

  it('names a permission the installation does not hold at all', () => {
    const { administration: _gone, ...without } = granted;
    expect(installationShortfall(without)).toEqual([
      { permission: 'administration', required: 'read', held: null },
    ]);
  });

  it('names a permission the installation holds below the level needed', () => {
    expect(installationShortfall({ ...granted, contents: 'read' })).toEqual([
      { permission: 'contents', required: 'write', held: 'read' },
    ]);
  });

  it('treats a level it does not recognise as a shortfall rather than a pass', () => {
    expect(installationShortfall({ ...granted, checks: 'maybe' })).toEqual([
      { permission: 'checks', required: 'write', held: 'maybe' },
    ]);
  });

  it('points an organisation-owned App at its own settings page', () => {
    expect(
      appPermissionsPageUrl({
        slug: 'forge-dev',
        ownerLogin: 'SidCorp-co',
        ownerType: 'Organization',
      }),
    ).toBe('https://github.com/organizations/SidCorp-co/settings/apps/forge-dev/permissions');
  });

  it('points a personal App at the personal settings page', () => {
    expect(
      appPermissionsPageUrl({ slug: 'forge-dev', ownerLogin: 'someone', ownerType: 'User' }),
    ).toBe('https://github.com/settings/apps/forge-dev/permissions');
  });

  it('says the permission, the page and that the installation must then accept it', () => {
    const said = describeShortfall({
      repository: 'SidCorp-co/forge',
      shortfall: [{ permission: 'administration', required: 'read', held: null }],
      permissionsUrl:
        'https://github.com/organizations/SidCorp-co/settings/apps/forge-dev/permissions',
      installationUrl: 'https://github.com/organizations/SidCorp-co/settings/installations/42',
    });
    expect(said).toContain('`administration: read`');
    expect(said).toContain('/settings/apps/forge-dev/permissions');
    expect(said).toContain('accept the new grant on the installation');
    expect(said).toContain('https://github.com/organizations/SidCorp-co/settings/installations/42');
  });

  it('still names the page in prose when GitHub would not say who the App is', () => {
    const said = describeShortfall({
      repository: 'SidCorp-co/forge',
      shortfall: [{ permission: 'administration', required: 'read', held: null }],
      permissionsUrl: null,
      installationUrl: null,
    });
    expect(said).toContain("the App's own page, not the installation's");
    expect(said).toContain('accept the new grant on the installation');
  });
});
