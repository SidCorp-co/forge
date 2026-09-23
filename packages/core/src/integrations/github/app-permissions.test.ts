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
import { GITHUB_ENDPOINTS, requiredAppPermissions } from './app-permissions.js';
import {
  ALIASED_RESPONSE,
  ARROW_TRANSPORT,
  ASSIGNED_ARGS,
  BARE_GET,
  CLIENT_TRANSPORTS,
  COMPUTED_KEY,
  CONCATENATED,
  CONST_PATH,
  DECLARATIONS_ONLY,
  DESTRUCTURED_MEMBER,
  DYNAMIC_METHOD,
  ENCODE_URI_HOLE,
  ENCODED_SEGMENT,
  EXTRACTED_ENCODING,
  EXTRACTED_MEMBER,
  GITHUB_JSON,
  MULTI_SEGMENT_HOLE,
  MUTATED_PATH,
  NESTED_SPREAD_OVERRIDE,
  NO_METHOD,
  OBJECT_HELD_TRANSPORT,
  QUOTED_METHOD,
  READABLE_GET,
  REAL_UNDECLARED_PATH,
  RETURNED_ARGS,
  SCALAR_METHOD,
  SHADOWED_HOLE,
  SHORTHAND,
  SPREAD_METHOD,
  SPREAD_OVERRIDE,
  SPREAD_THEN_METHOD,
  SPREAD_THEN_PATH,
  TRAILING_COMMA,
  TRANSPORT_ADDED,
  TRANSPORT_PROPERTY,
  TRANSPORT_SWAPPED,
  TWO_HOP_ALIAS,
  UNRESOLVED,
  UNTYPED_ELEMENT_ACCESS,
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

  it('names a transport extracted into a name before the call that uses it', () => {
    expect(only(collectGitHubCalls(EXTRACTED_MEMBER)).unresolved).toContain('queuePath(client)');
  });

  it('names a transport destructured out of the client it belongs to', () => {
    expect(only(collectGitHubCalls(DESTRUCTURED_MEMBER)).unresolved).toContain('queuePath(client)');
  });

  it('derives a transport written as an arrow property, not only as a method', () => {
    const found = only(collectGitHubCalls(ARROW_TRANSPORT).filter((c) => c.kind === 'path'));
    expect(found.unresolved).toContain('queuePath()');
  });

  it('derives a transport whose Response promise is spelled through an alias', () => {
    const found = only(collectGitHubCalls(ALIASED_RESPONSE).filter((c) => c.kind === 'path'));
    expect(found.unresolved).toContain('queuePath()');
  });

  it('reads a method the transport takes as an argument of its own, never defaulting to GET', () => {
    const found = only(collectGitHubCalls(SCALAR_METHOD).filter((c) => c.kind === 'path'));
    expect(key(found.method, found.path)).toBe('POST /repos/a/b/merge-queue');
  });

  it('reads a value that WEARS a declared hole’s spelling rather than substituting the hole', () => {
    const found = only(collectGitHubCalls(SHADOWED_HOLE));
    expect(found.path).toBe('/repos/a/b/c/pulls');
  });

  it('refuses the untyped residual reached by an element access too', () => {
    expect(only(collectGitHubCalls(UNTYPED_ELEMENT_ACCESS)).unresolved).toContain(
      'publish is a transport',
    );
  });

  it('follows a transport alias as far as it goes, not one hop', () => {
    expect(only(collectGitHubCalls(TWO_HOP_ALIAS)).unresolved).toContain('endpoint');
  });

  it('gives back a path a later spread could overwrite unread', () => {
    expect(only(collectGitHubCalls(SPREAD_OVERRIDE)).unresolved).toContain(
      'a spread this checker cannot read may overwrite the path: override',
    );
  });

  it('keeps a path written after that spread, which the runtime would keep too', () => {
    const found = only(collectGitHubCalls(SPREAD_THEN_PATH));
    expect(found.unresolved).toBeNull();
    expect(found.path).toBe('/repos/:p/:p');
  });

  it('refuses a hole that nothing proves is one path segment', () => {
    expect(only(collectGitHubCalls(MULTI_SEGMENT_HOLE)).unresolved).toContain('reviewTail(n)');
  });

  it('accepts one the source proves carries no separator', () => {
    const found = only(collectGitHubCalls(ENCODED_SEGMENT));
    expect(found.unresolved).toBeNull();
    expect(found.path).toBe('/repos/:p/:p/pulls/:p');
  });

  it('refuses a request whose method it cannot read, rather than calling it a GET', () => {
    const found = only(collectGitHubCalls(DYNAMIC_METHOD));
    expect(found.unresolved).toContain('cannot read');
    expect(found.unresolved).toContain('method');
  });

  it('refuses encodeURI, which leaves the separator it is named for alone', () => {
    expect(only(collectGitHubCalls(ENCODE_URI_HOLE)).unresolved).toContain('encodeURI(tail)');
  });

  it('follows an encoder pulled out into a name of its own', () => {
    const found = only(collectGitHubCalls(EXTRACTED_ENCODING));
    expect(found.unresolved).toBeNull();
    expect(found.path).toBe('/repos/:p/:p/pulls/:p');
  });

  it('gives back a path a spread INSIDE a spread could overwrite unread', () => {
    expect(only(collectGitHubCalls(NESTED_SPREAD_OVERRIDE)).unresolved).toContain('overwrite');
  });

  it('refuses a request whose method a spread could set unread', () => {
    expect(only(collectGitHubCalls(SPREAD_METHOD)).unresolved).toContain('may set the method');
  });

  it('keeps a method written after that spread, which the runtime would keep too', () => {
    const found = only(collectGitHubCalls(SPREAD_THEN_METHOD));
    expect(found.unresolved).toBeNull();
    expect(key(found.method, found.path)).toBe('GET /repos/a/b/branches/main/protection');
  });

  it('refuses a path bound to a name that is written to after it is set', () => {
    expect(only(collectGitHubCalls(MUTATED_PATH)).unresolved).toContain('endpoint');
  });

  it('prices the same path bound once, which nothing can write to after', () => {
    const found = only(collectGitHubCalls(CONST_PATH));
    expect(found.unresolved).toBeNull();
    expect(found.path).toBe('/repos/:p/:p/branches/:p/protection');
  });

  it('follows a transport held in a property of an object of its own', () => {
    expect(only(collectGitHubCalls(OBJECT_HELD_TRANSPORT)).unresolved).toContain('endpoint');
  });

  it('reads a method named by a quoted key as that method, not as a missing one', () => {
    const found = only(collectGitHubCalls(QUOTED_METHOD));
    expect(found.unresolved).toBeNull();
    expect(key(found.method, found.path)).toBe('DELETE /repos/a/b/branches/:p/protection');
  });

  it('gives back a path a key it cannot read could be naming', () => {
    expect(only(collectGitHubCalls(COMPUTED_KEY)).unresolved).toContain('which');
  });

  it('names that same path in the sweep over what is written, not only at the call', () => {
    expect(undeclaredPathsIn(REAL_UNDECLARED_PATH).join(' ')).toContain('/repos/:p/:p/merge-queue');
  });
});
