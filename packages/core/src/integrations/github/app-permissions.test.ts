/**
 * ISS-1153 — an App created from Forge's manifest can do everything Forge's code asks of it.
 *
 * The manifest asked for six permissions and `readProtection` needed a seventh, so a merge died on
 * a 403 while every health signal said `ok`. The gap was not the permission; it was that nothing
 * compared the two lists. This is the comparison.
 *
 * The required side is derived, not listed: the paths come out of the source, so a call site added
 * later is measured rather than assumed. A path expression the checker cannot resolve is a named
 * failure and not a skip — that is the only thing standing between a helper-built path and a silent
 * green, and it is planted here rather than trusted. The checker itself is `app-permissions.fixture.ts`.
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
  GITHUB_DIR,
  handledEvents,
  hasRequestHelper,
  key,
  manifest,
  REQUEST_HELPERS,
  sourceFiles,
  withoutComments,
} from './app-permissions.fixture.js';
import {
  appPermissionsPageUrl,
  describeShortfall,
  GITHUB_ENDPOINTS,
  installationShortfall,
  requiredAppPermissions,
} from './app-permissions.js';

describe('the manifest requests what Forge’s code needs (ISS-1153)', () => {
  const calls = callsInTree();

  it('resolves every GitHub path expression in the integration', () => {
    const stuck = callsToPrice(calls).filter((c) => c.unresolved);
    expect(
      stuck.map((c) => `${c.file}:${c.line} — ${c.unresolved}`),
      'a call this checker cannot read is a call it cannot price; declare the path plainly or teach resolvePath the shape',
    ).toEqual([]);
    expect(calls.length).toBeGreaterThan(20);
  });

  it('names the file, the line and the expression of a path it cannot resolve', () => {
    const planted = [
      'async function f(client) {',
      '  await client.publish({',
      "    op: 'lookup',",
      "    method: 'GET',",
      '    path: somewhereElse(client),',
      '  });',
      '}',
    ].join('\n');
    const found = collectGitHubCalls(planted, 'planted.ts');
    expect(found).toHaveLength(1);
    expect(found[0]?.unresolved).toContain('somewhereElse(client)');
    expect(found[0]?.file).toBe('planted.ts');
    expect(found[0]?.line).toBe(5);
  });

  it('names the call whose HTTP method it cannot read', () => {
    const seg = ['$', '{a}'].join('');
    const planted = ['await client.json({', `  path: \`/repos/${seg}/pulls\`,`, '});'].join('\n');
    const found = collectGitHubCalls(planted, 'planted.ts');
    expect(found[0]?.unresolved).toContain('names no HTTP method');
  });

  it('holds an endpoint record for every call the source makes', () => {
    const declared = new Set(GITHUB_ENDPOINTS.map((e) => key(e.method, e.path)));
    const orphans = callsToPrice(calls)
      .filter((c) => !c.unresolved && !declared.has(key(c.method, c.path)))
      .map((c) => `${c.file}:${c.line} — ${key(c.method, c.path)}`);
    expect(
      orphans,
      'declare it in app-permissions.ts with the permission GitHub documents for it',
    ).toEqual([]);
  });

  it('holds no endpoint record the source no longer calls', () => {
    const made = new Set(
      callsToPrice(calls)
        .filter((c) => !c.unresolved)
        .map((c) => key(c.method, c.path)),
    );
    const stale = GITHUB_ENDPOINTS.map((e) => key(e.method, e.path)).filter((k) => !made.has(k));
    expect(
      stale,
      'the call site is gone; drop the row rather than keeping the permission it buys',
    ).toEqual([]);
  });

  it('declares every file that makes a request the checker cannot read a path out of', () => {
    const undeclared = sourceFiles().filter(
      (f) => hasRequestHelper(f, readFileSync(join(GITHUB_DIR, f), 'utf8')) && !REQUEST_HELPERS[f],
    );
    expect(
      undeclared,
      'this file calls fetch with a URL the checker cannot read; name the path at the call site, or declare the helper in REQUEST_HELPERS',
    ).toEqual([]);
  });

  it('declares no request helper that no longer exists', () => {
    const gone = Object.keys(REQUEST_HELPERS).filter(
      (f) =>
        !sourceFiles().includes(f) ||
        !hasRequestHelper(f, readFileSync(join(GITHUB_DIR, f), 'utf8')),
    );
    expect(
      gone,
      'the helper is gone; drop the entry rather than keeping a hole open for it',
    ).toEqual([]);
  });

  it('the declaration file makes no GitHub call of its own', () => {
    const text = readFileSync(join(GITHUB_DIR, DECLARATION_FILE), 'utf8');
    expect(
      /\b(?:fetch|doFetch|client\.(?:get|json|text|publish))\s*[(<]/.test(withoutComments(text)),
    ).toBe(false);
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
    const faults = auditPermissions(weakened, requiredAppPermissions());
    expect(faults).toEqual([
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
    const faults = auditEvents(
      [...m.default_events, 'release'],
      handledEvents(),
      m.default_permissions,
    );
    expect(faults).toEqual([{ kind: 'undeclared', event: 'release' }]);
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
    const faults = auditEvents(m.default_events, handledEvents(), without);
    expect(faults).toEqual([{ kind: 'ungranted', event: 'workflow_run', required: 'read' }]);
  });

  it('holds the lockstep annotation on both sides of the pair', () => {
    const here = GITHUB_DIR;
    const registry = readFileSync(join(here, 'app-permissions.ts'), 'utf8');
    const connect = readFileSync(join(here, 'connect.ts'), 'utf8');
    expect(registry).toContain(
      'cm:edge lockstep -> packages/core/src/integrations/github/connect.ts',
    );
    expect(connect).toContain(
      'cm:edge lockstep -> packages/core/src/integrations/github/app-permissions.ts',
    );
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
