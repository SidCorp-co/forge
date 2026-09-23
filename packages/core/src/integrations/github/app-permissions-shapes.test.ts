/**
 * ISS-1153 — a GitHub call is found by what it CALLS, however its arguments are written.
 *
 * Three rounds of regex enumeration each closed the shapes the round before had named and left the
 * class open; seven reviews of the AST checker that replaced them found twenty-four more. Each shape
 * below was planted, watched go red at the head before its fix, and sits beside the positive control
 * the refusal must not swallow. `app-permissions.test.ts` holds the manifest comparison itself.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectGitHubCalls,
  type FoundCall,
  key,
  orphansIn,
  sourceFilesIn,
  undeclaredPathsIn,
  unreadableRequests,
} from './app-permissions.fixture.js';
import {
  ASSIGNED_ARGS,
  BARE_GET,
  CONCATENATED,
  DECLARATIONS_ONLY,
  GITHUB_JSON,
  READABLE_GET,
  REAL_UNDECLARED_PATH,
  RETURNED_ARGS,
  SHORTHAND,
  TRAILING_COMMA,
  UNTYPED_RECEIVER,
  VARIABLE_PATH,
} from './app-permissions-plants.fixture.js';
import {
  ALIAS_MUTATION,
  ALIASED_RESPONSE,
  ARROW_TRANSPORT,
  BOUND_TRANSPORT,
  COMPUTED_KEY,
  CONST_PATH,
  DESTRUCTURED_MEMBER,
  DYNAMIC_METHOD,
  ENCODE_URI_HOLE,
  ENCODED_SEGMENT,
  EXTRACTED_ENCODING,
  EXTRACTED_MEMBER,
  MULTI_SEGMENT_HOLE,
  MUTATED_ARGS,
  MUTATED_PATH,
  MUTATED_PROPERTY,
  NESTED_SPREAD_OVERRIDE,
  OBJECT_HELD_TRANSPORT,
  QUOTED_METHOD,
  REFLECTED_TRANSPORT,
  SCALAR_METHOD,
  SHADOWED_HOLE,
  SHIFTED_TRANSPORT,
  SHORTHAND_HELD_TRANSPORT,
  SPREAD_METHOD,
  SPREAD_OVERRIDE,
  SPREAD_THEN_METHOD,
  SPREAD_THEN_PATH,
  STABLE_PROPERTY,
  TWO_HOP_ALIAS,
  UNTYPED_ELEMENT_ACCESS,
} from './app-permissions-plants-review.fixture.js';

const only = (calls: FoundCall[]): FoundCall => {
  expect(calls).toHaveLength(1);
  return calls[0] as FoundCall;
};

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

  it('refuses a const object whose property is written to after it is built', () => {
    expect(only(collectGitHubCalls(MUTATED_ARGS)).unresolved).toContain('args');
  });

  it('follows a transport held by a shorthand property of an object', () => {
    expect(only(collectGitHubCalls(SHORTHAND_HELD_TRANSPORT)).unresolved).toContain('endpoint');
  });

  it('reads a source one directory down, which a listing of the top level would miss', () => {
    const root = mkdtempSync(join(tmpdir(), 'iss1153-'));
    mkdirSync(join(root, 'helpers'));
    writeFileSync(join(root, 'top.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'helpers', 'extra.ts'), 'export const b = 2;\n');
    writeFileSync(join(root, 'helpers', 'extra.test.ts'), 'export const c = 3;\n');
    expect(sourceFilesIn(root).sort()).toEqual(['helpers/extra.ts', 'top.ts']);
  });

  it('refuses a scalar property of an object written to after it is built', () => {
    expect(only(collectGitHubCalls(MUTATED_PROPERTY)).unresolved).toContain('args.path');
  });

  it('prices the same property on an object nothing writes to', () => {
    const found = only(collectGitHubCalls(STABLE_PROPERTY));
    expect(found.unresolved).toBeNull();
    expect(found.path).toBe('/repos/:p/:p/pulls');
  });

  it('follows a transport bound to its receiver, which moves no argument', () => {
    expect(only(collectGitHubCalls(BOUND_TRANSPORT)).unresolved).toContain('endpoint');
  });

  it('refuses a transport bound with an argument, which moves every other one', () => {
    expect(only(collectGitHubCalls(SHIFTED_TRANSPORT)).unresolved).toContain(
      'does not put its arguments where its signature does',
    );
  });

  it('refuses an object written to through a second name of its own', () => {
    expect(only(collectGitHubCalls(ALIAS_MUTATION)).unresolved).toContain('args.path');
  });

  it('refuses a transport reached through call, whose arguments are not its own', () => {
    expect(only(collectGitHubCalls(REFLECTED_TRANSPORT)).unresolved).toContain(
      'does not put its arguments where its signature does',
    );
  });

  it('names that same path in the sweep over what is written, not only at the call', () => {
    expect(undeclaredPathsIn(REAL_UNDECLARED_PATH).join(' ')).toContain('/repos/:p/:p/merge-queue');
  });
});
