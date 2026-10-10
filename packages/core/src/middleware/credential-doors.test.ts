// Every door a bearer credential is admitted at, and what a chat credential meets there (REQ-30 BC-4,
// ISS-439). A chat credential is a token core minted for a chat — an Agent session's turn token, the
// Assistant's turn token, an agreed proposal's token — and every one is a PAT, so it is never a
// session JWT, and the one chat write rule has to run wherever a PAT is admitted. The integration
// suite (`tests/integration/chat-agreement-default-e2e.test.ts`) presents a real turn token at each
// door.
//
// The list is closed against the source by binding, not by call text (round 5: the release judge
// admitted a credential through `import { verifyPat as checkPresented }` and a text match never saw
// it). Every module is parsed; a module is a door when any of its code reaches a verifier however
// it is bound — a named import under any alias, a namespace or default import, a dynamic import, a
// re-export or `export *`, a module importing from such a barrel — or reaches the primitives a
// credential is verified with directly. A verifier is any exported binding that reaches one, so a
// wrapper exported under a new name is followed to its importers too; only the gates named below
// stop the walk, because the routes behind a gate are behind its door.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a presented credential is checked with, by the package exporting it. */
const PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  argon2: ['verify'],
  jose: ['jwtVerify'],
};

/** Each module that admits a presented credential, and what a chat credential meets in it. */
const DOORS: Readonly<Record<string, string>> = {
  'credentials/pat.ts': 'defines verifyPat, the one PAT verification every door below calls',
  'credentials/jwt.ts':
    'defines verifyUserToken: a session JWT, which no chat credential is (every one is a PAT)',
  'credentials/device-credential.ts':
    'readBoxToken reads a token core handed a chat as handed, never as the box it is fenced to',
  'middleware/pat-rest-surface.ts':
    'beginPatRequest, called only by auth.ts:admitPat, which runs admitChatWrite on every write',
  'middleware/auth.ts':
    'requireAuth and requireUserOrDevice admit a chat credential through admitPat, so the chat write rule runs',
  'middleware/require-device.ts':
    'requireDevice refuses a chat credential TURN_CREDENTIAL_NOT_A_BOX',
  'middleware/require-pat.ts':
    'requirePat admits /mcp, where mcp/server.ts asks rest-hold.ts:refuseChatToolWrite before a tool runs',
  'project-config/routes.ts':
    'callingDevice is a read on a route requireAuth admits; a chat credential names no device there',
  'project-config/testing-secrets-routes.ts':
    'a job credential reads one job’s testing secrets: GET only, decided by the job it names',
  'ws/server.ts': 'resolveBearer opens the socket for a person or a box, never a chat credential',
  'auth/password.ts': 'defines verifyPassword: a password hash, which no chat credential is',
  'auth/login.ts':
    'session sign-in takes an email and a password and refuses an agent; a chat credential is neither',
  'auth/reauth.ts':
    'a password recheck behind requireAuth, where the chat write rule runs first; a chat credential carries no password',
  'credentials/refresh-token.ts':
    'defines verifyRefreshToken: a refresh token hash, which a PAT never matches',
  'auth/service.ts':
    'rotateRefreshToken matches a refresh token under its prefix; a chat credential is a PAT, never one',
  'auth/refresh.ts':
    'reads the refresh cookie and refuses an agent; a chat credential is never a refresh token',
  'auth/oauth/state.ts':
    'defines verifyState: the OAuth state cookie, a JWT under its own issuer that admits no caller',
  'auth/oauth/handler.ts':
    'handleCallback signs a person in from the provider’s answer and its state cookie, never a presented token',
  'previews/ticket.ts':
    'a preview ticket and viewer cookie are JWTs under their own issuers; a PAT verifies as neither',
  'previews/relay.ts':
    'the preview host admits a viewer by its cookie or a ticket it spends, never a bearer token',
};

/**
 * Exported bindings that admit through a verifier and are mounted as middleware: the routes they
 * guard sit behind the door that exports them, so the walk stops here.
 */
const GATES: Readonly<Record<string, readonly string[]>> = {
  'middleware/auth.ts': ['requireAuth', 'requireUserOrDevice'],
  'middleware/require-device.ts': ['requireDevice'],
  'middleware/require-pat.ts': ['requirePat'],
  'auth/oauth/handler.ts': ['handleCallback'],
  'previews/relay.ts': ['withPreviewHosts', 'relayPreviewRequest', 'relayPreviewUpgrade'],
  'ws/server.ts': ['attachWs'],
};

type ImportBinding = { from: string; name: string } | { from: string; namespace: true };

interface Module {
  key: string;
  file: ts.SourceFile;
  /** Local name → what it is bound to, for value imports of a module or package we follow. */
  bindings: Map<string, ImportBinding>;
  /** Top-level declarations by name, and whether each is exported. */
  decls: Map<string, { node: ts.Node; exported: boolean }>;
  /** `export { local as exported }` with no `from`. */
  localExports: Map<string, string>;
  /** `export { name as exported } from` (a name map) and `export * from` ('*'). */
  reexports: { from: string; names: Map<string, string> | '*' }[];
  /** Each top-level declaration's node → its name, built on first use. */
  owners?: Map<ts.Node, string>;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const ALIASES: Readonly<Record<string, string>> = { '@forge/core/public': 'public.ts' };

/** The module a specifier names: a path under src, a package we follow, or null. */
function resolveSpecifier(fromKey: string, specifier: string, keys: Set<string>): string | null {
  if (specifier in PRIMITIVES) return specifier;
  if (specifier in ALIASES) return ALIASES[specifier] ?? null;
  if (!specifier.startsWith('.')) return null;
  const base = relative(SRC, resolve(SRC, dirname(fromKey), specifier));
  const stem = base.replace(/\.(js|ts)$/, '');
  return [`${stem}.ts`, `${base}/index.ts`].find((k) => keys.has(k)) ?? null;
}

function isExported(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function readModule(path: string, keys: Set<string>): Module {
  const key = relative(SRC, path);
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const mod: Module = {
    key,
    file,
    bindings: new Map(),
    decls: new Map(),
    localExports: new Map(),
    reexports: [],
  };
  for (const stmt of file.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const from = resolveSpecifier(key, stmt.moduleSpecifier.text, keys);
      const clause = stmt.importClause;
      if (!from || !clause || clause.isTypeOnly) continue;
      if (clause.name) mod.bindings.set(clause.name.text, { from, namespace: true });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        mod.bindings.set(named.name.text, { from, namespace: true });
      } else if (named) {
        for (const el of named.elements) {
          if (el.isTypeOnly) continue;
          mod.bindings.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
        }
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      const spec = stmt.moduleSpecifier;
      const clause = stmt.exportClause;
      const pairs = new Map<string, string>();
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          if (!el.isTypeOnly) pairs.set(el.name.text, (el.propertyName ?? el.name).text);
        }
      }
      if (!spec || !ts.isStringLiteral(spec)) {
        for (const [exported, local] of pairs) mod.localExports.set(exported, local);
        continue;
      }
      const from = resolveSpecifier(key, spec.text, keys);
      if (from) mod.reexports.push({ from, names: clause ? pairs : '*' });
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        for (const name of boundNames(d.name)) {
          mod.decls.set(name, { node: d, exported: isExported(stmt) });
        }
      }
    } else if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      mod.decls.set(stmt.name.text, { node: stmt, exported: isExported(stmt) });
    }
  }
  return mod;
}

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
}

/** The top-level statement or declaration a node sits in: its name, or '' for module-level code. */
function ownerOf(mod: Module, node: ts.Node): string {
  mod.owners ??= new Map([...mod.decls].map(([name, decl]) => [decl.node, name]));
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    const name = mod.owners.get(at);
    if (name !== undefined) return name;
  }
  return '';
}

/**
 * Where the module's code touches a carried name: each owning declaration ('' for module-level
 * code), and the local declarations each one references, for the walk inside the module.
 */
function touches(mod: Module, carried: Map<string, Set<string>>) {
  const hits = new Set<string>();
  const refs = new Map<string, Set<string>>();
  const carries = (from: string, name?: string) =>
    name === undefined
      ? (carried.get(from)?.size ?? 0) > 0
      : (carried.get(from)?.has(name) ?? false);
  const hit = (node: ts.Node) => hits.add(ownerOf(mod, node));

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const from = resolveSpecifier(mod.key, node.arguments[0].text, new Set(carried.keys()));
      if (from && carries(from)) dynamicImport(node, from);
    }
    if (ts.isIdentifier(node)) identifier(node);
    ts.forEachChild(node, visit);
  };

  const dynamicImport = (call: ts.CallExpression, from: string) => {
    let at: ts.Node = call.parent;
    while (ts.isAwaitExpression(at) || ts.isParenthesizedExpression(at)) at = at.parent;
    if (ts.isVariableDeclaration(at) && ts.isObjectBindingPattern(at.name)) {
      const names = at.name.elements.map((el) => (el.propertyName ?? el.name).getText(mod.file));
      if (names.some((n) => carries(from, n))) hit(call);
    } else if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) {
      mod.bindings.set(at.name.text, { from, namespace: true });
    } else {
      hit(call);
    }
  };

  const identifier = (id: ts.Identifier) => {
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return;
    if (ts.isPropertyAssignment(parent) && parent.name === id) return;
    if (ts.isBindingElement(parent) && parent.propertyName === id) return;
    const local = mod.decls.has(id.text) && !isDeclarationName(id);
    if (local) {
      const owner = ownerOf(mod, id);
      const set = refs.get(owner) ?? new Set<string>();
      set.add(id.text);
      refs.set(owner, set);
    }
    const binding = mod.bindings.get(id.text);
    if (!binding || isDeclarationName(id)) return;
    if (!('namespace' in binding)) {
      if (carries(binding.from, binding.name)) hit(id);
      return;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      if (carries(binding.from, parent.name.text)) hit(id);
    } else if (carries(binding.from)) {
      hit(id);
    }
  };

  visit(mod.file);
  return { hits, refs };
}

function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    ((ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p)) &&
      p.name === id) ||
    ts.isImportSpecifier(p) ||
    ts.isImportClause(p) ||
    ts.isNamespaceImport(p)
  );
}

/** Each door, and the bindings each module exports that reach a verifier. */
function readDoors() {
  const paths = sources(SRC);
  const keys = new Set(paths.map((p) => relative(SRC, p)));
  const modules = paths.map((p) => readModule(p, keys));
  const carried = new Map<string, Set<string>>(
    Object.entries(PRIMITIVES).map(([pkg, names]) => [pkg, new Set(names)]),
  );
  for (const k of keys) carried.set(k, new Set());

  const doors = new Set<string>();
  const reaching = new Map<string, Set<string>>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const mod of modules) {
      const { hits, refs } = touches(mod, carried);
      const reach = new Set(hits);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [owner, names] of refs) {
          if (!reach.has(owner) && [...names].some((n) => reach.has(n))) {
            reach.add(owner);
            grew = true;
          }
        }
      }
      const exported = new Set<string>();
      for (const [name, decl] of mod.decls)
        if (decl.exported && reach.has(name)) exported.add(name);
      for (const [name, local] of mod.localExports) {
        const b = mod.bindings.get(local);
        const viaImport = b && !('namespace' in b) && carried.get(b.from)?.has(b.name);
        if (reach.has(local) || viaImport) exported.add(name);
      }
      for (const { from, names } of mod.reexports) {
        const theirs = carried.get(from) ?? new Set<string>();
        if (names === '*') for (const n of theirs) exported.add(n);
        else for (const [name, imported] of names) if (theirs.has(imported)) exported.add(name);
      }
      if (reach.size > 0 || exported.size > 0) doors.add(mod.key);
      reaching.set(mod.key, exported);
      const gates = new Set(GATES[mod.key] ?? []);
      const next = new Set([...exported].filter((n) => !gates.has(n)));
      const before = carried.get(mod.key) ?? new Set<string>();
      if (next.size !== before.size || [...next].some((n) => !before.has(n))) {
        carried.set(mod.key, next);
        changed = true;
      }
    }
  }
  return { doors: [...doors].sort(), reaching, modules };
}

const read = readDoors();

describe('every door a credential is admitted at is named, with what a chat credential meets there', () => {
  it('names exactly the modules that reach a credential verifier, however it is bound', () => {
    expect(read.doors).toEqual(Object.keys(DOORS).sort());
  });

  it('names each gate as a binding its door exports that reaches a verifier', () => {
    for (const [door, gates] of Object.entries(GATES)) {
      for (const gate of gates) expect(read.reaching.get(door), `${door}:${gate}`).toContain(gate);
    }
  });

  it('/mcp asks the chat write rule before a tool runs', () => {
    const mcp = readFileSync(join(SRC, 'mcp/server.ts'), 'utf8');
    expect(mcp).toMatch(/await chatToolWriteRefusal\(name, args,/);
  });

  it('the only PAT admission on the REST plane runs the chat write rule', () => {
    const auth = readFileSync(join(SRC, 'middleware/auth.ts'), 'utf8');
    const admitPat = auth.slice(auth.indexOf('async function admitPat('));
    expect(admitPat.slice(0, admitPat.indexOf('\n}\n'))).toContain('await admitChatWrite(c);');
    const surface = 'middleware/pat-rest-surface.ts';
    const binders = read.modules
      .filter((m) =>
        [...m.bindings.values()].some(
          (b) => b.from === surface && ('namespace' in b || b.name === 'beginPatRequest'),
        ),
      )
      .map((m) => m.key);
    expect(binders.sort()).toEqual(['middleware/auth.ts']);
  });
});
