// The walk credential-doors.test.ts runs over core's source: every module a credential arrives at
// or is checked in, followed by binding from the accesses credential-access.fixture.ts read. The
// declarations it walks with (which accesses bring a credential, which functions check one, which
// gates stop it) are the test's, passed in, so this file holds machinery and the test the claims.

import { posix } from 'node:path';
import ts from 'typescript';
import type { Access } from './credential-ast.fixture.js';

/** What the test declares and the walk reads. */
export interface WalkConfig {
  /** Each module of core's src by its key, parsed by the scan's program. */
  readonly files: ReadonlyMap<string, ts.SourceFile>;
  /** Each module's request accesses. */
  readonly accesses: ReadonlyMap<string, readonly Access[]>;
  /** Whether an access brings a presented credential in. */
  readonly isSeed: (access: Access) => boolean;
  /** What a presented secret is checked with, or read through, by the package exporting it. */
  readonly primitives: Readonly<Record<string, readonly string[]>>;
  /** Core's own functions a presented secret is checked through, by module. */
  readonly coreSeeds: Readonly<Record<string, readonly string[]>>;
  /** Exported bindings mounted as middleware, where the walk stops. */
  readonly gates: Readonly<Record<string, readonly string[]>>;
}

export type ImportBinding = { from: string; name: string } | { from: string; namespace: true };

export interface Module {
  key: string;
  file: ts.SourceFile;
  /** Local name → what it is bound to, for value imports of a module or package we follow. */
  bindings: Map<string, ImportBinding>;
  /** Top-level declarations by name, and whether each is exported. */
  decls: Map<string, { node: ts.Node; exported: boolean }>;
  /** `export { local as exported }` with no `from`, and `export default function local`. */
  localExports: Map<string, string>;
  /** `export { name as exported } from` (a name map) and `export * from` ('*'). */
  reexports: { from: string; names: Map<string, string> | '*' }[];
  /** Each top-level declaration's node → its name, built on first use. */
  owners?: Map<ts.Node, string>;
}

const ALIASES: Readonly<Record<string, string>> = { '@forge/core/public': 'public.ts' };

/** The module a specifier names: a path under src, a package we follow, or null. */
function resolveSpecifier(
  cfg: WalkConfig,
  fromKey: string,
  specifier: string,
  keys: Set<string>,
): string | null {
  if (specifier in cfg.primitives) return specifier;
  if (specifier in ALIASES) return ALIASES[specifier] ?? null;
  if (!specifier.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromKey), specifier));
  const stem = base.replace(/\.(js|ts)$/, '');
  return [`${stem}.ts`, `${base}/index.ts`].find((k) => keys.has(k)) ?? null;
}

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);

function readModule(cfg: WalkConfig, key: string, file: ts.SourceFile, keys: Set<string>): Module {
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
      const from = resolveSpecifier(cfg, key, stmt.moduleSpecifier.text, keys);
      const clause = stmt.importClause;
      if (!from || !clause || clause.isTypeOnly) continue;
      // a package's default export is the package itself; a module's is its `default` binding
      if (clause.name) {
        const bound: ImportBinding =
          from in cfg.primitives ? { from, namespace: true } : { from, name: 'default' };
        mod.bindings.set(clause.name.text, bound);
      }
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
      const from = resolveSpecifier(cfg, key, spec.text, keys);
      if (from) mod.reexports.push({ from, names: clause ? pairs : '*' });
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // `export default <expression>`: a binding named `default`, whatever the expression is
      mod.decls.set('default', { node: stmt, exported: true });
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        for (const name of boundNames(d.name)) {
          mod.decls.set(name, {
            node: d,
            exported: hasModifier(stmt, ts.SyntaxKind.ExportKeyword),
          });
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
      const exported = hasModifier(stmt, ts.SyntaxKind.ExportKeyword);
      const isDefault = exported && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      const name = stmt.name?.text ?? 'default';
      mod.decls.set(name, { node: stmt, exported: exported && !isDefault });
      if (isDefault) mod.localExports.set('default', name);
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

/** The identifier at the root of a callee: `a` in `a(…)`, `a.b.c(…)` and `a.b()(…)`. */
function calleeRoot(expr: ts.Expression): ts.Identifier | null {
  let at: ts.Expression = expr;
  for (;;) {
    if (ts.isIdentifier(at)) return at;
    if (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) at = at.expression;
    else if (ts.isCallExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
    else if (ts.isAsExpression(at) || ts.isNonNullExpression(at)) at = at.expression;
    else return null;
  }
}

/**
 * The call a value is handed to as an argument, through any object or array literal around it, or
 * null when the value is used some other way.
 */
function handedTo(id: ts.Identifier): ts.CallExpression | ts.NewExpression | null {
  let at: ts.Node = id;
  for (;;) {
    const parent = at.parent;
    if (
      ts.isPropertyAssignment(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent)
    ) {
      if (ts.isPropertyAssignment(parent) && parent.name === at) return null;
      at = parent;
      continue;
    }
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== at) {
      return parent.arguments?.includes(at as ts.Expression) ? parent : null;
    }
    return null;
  }
}

interface Handoff {
  owner: string;
  name: string;
  local: boolean;
  how: string;
}

const PASS_THROUGH = (n: ts.Node) =>
  ts.isParenthesizedExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isAwaitExpression(n);

/**
 * How an imported verifier is used where it appears: called (itself or a member of it), aliased by
 * a top-level declaration or a default export (both followed by the walk), named only in a type, or
 * used as a value: placed in a literal or a local binding is followed through the declaration that
 * holds it; handed to a call as an argument is a hand-off no walk can follow.
 */
function useOf(mod: Module, ref: ts.Expression): 'call' | 'alias' | 'type' | 'value' {
  if (ts.findAncestor(ref, (n) => ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n))) {
    return 'type';
  }
  let at: ts.Node = ref;
  while (PASS_THROUGH(at.parent)) at = at.parent;
  const parent = at.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === at) {
    return 'call';
  }
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === at) return 'call';
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === at &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return 'call';
  }
  if (ts.isExportAssignment(parent)) return 'alias';
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === at &&
    ts.isIdentifier(parent.name) &&
    mod.decls.get(parent.name.text)?.node === parent
  ) {
    return 'alias';
  }
  return 'value';
}

/**
 * Where the module's code touches a carried name or reads a credential: each owning declaration
 * ('' for module-level code), the local declarations each one references, and each carried value
 * handed to another module's function.
 */
function touches(cfg: WalkConfig, mod: Module, carried: Map<string, Set<string>>) {
  const hits = new Set<string>();
  const refs = new Map<string, Set<string>>();
  const handoffs: Handoff[] = [];
  const carries = (from: string, name?: string) =>
    name === undefined
      ? (carried.get(from)?.size ?? 0) > 0
      : (carried.get(from)?.has(name) ?? false);
  const hit = (node: ts.Node) => hits.add(ownerOf(mod, node));
  const intoModule = (call: ts.CallExpression | ts.NewExpression) => {
    const root = calleeRoot(call.expression);
    const bound = root ? mod.bindings.get(root.text) : undefined;
    return bound && !(bound.from in cfg.primitives) ? root : null;
  };

  for (const access of cfg.accesses.get(mod.key) ?? []) if (cfg.isSeed(access)) hit(access.node);
  for (const name of cfg.coreSeeds[mod.key] ?? []) {
    const decl = mod.decls.get(name);
    if (decl) hit(decl.node);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const from = resolveSpecifier(cfg, mod.key, node.arguments[0].text, new Set(carried.keys()));
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
    if (isDeclarationName(id)) return;
    const call = handedTo(id);
    const receiver = call ? intoModule(call) : null;
    if (mod.decls.has(id.text)) {
      const owner = ownerOf(mod, id);
      const set = refs.get(owner) ?? new Set<string>();
      set.add(id.text);
      refs.set(owner, set);
      if (receiver) {
        handoffs.push({ owner, name: id.text, local: true, how: `handed to ${receiver.text}(…)` });
      }
    }
    const binding = mod.bindings.get(id.text);
    if (!binding) return;
    let carriedHere: boolean;
    let ref: ts.Expression = id;
    if (!('namespace' in binding)) carriedHere = carries(binding.from, binding.name);
    else if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      carriedHere = carries(binding.from, parent.name.text);
      ref = parent;
    } else carriedHere = carries(binding.from);
    if (!carriedHere) return;
    const use = useOf(mod, ref);
    if (use === 'type') return;
    if (use === 'value' && call) {
      const how = receiver
        ? `handed to ${receiver.text}(…)`
        : `handed to ${call.expression.getText(mod.file)}(…)`;
      handoffs.push({ owner: ownerOf(mod, id), name: ref.getText(mod.file), local: false, how });
      return;
    }
    hit(id);
  };

  visit(mod.file);
  return { hits, refs, handoffs };
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

/** Each module a credential reaches, the bindings each module exports that reach one, each hand-off. */
export function readDoors(cfg: WalkConfig) {
  const keys = new Set(cfg.files.keys());
  const modules = [...cfg.files].map(([key, file]) => readModule(cfg, key, file, keys));
  const carried = new Map<string, Set<string>>(
    Object.entries(cfg.primitives).map(([pkg, names]) => [pkg, new Set(names)]),
  );
  for (const k of keys) carried.set(k, new Set());

  const doors = new Set<string>();
  const reaching = new Map<string, Set<string>>();
  const handoffs = new Map<string, string[]>();
  for (let changed = true; changed; ) {
    changed = false;
    doors.clear();
    for (const mod of modules) {
      const touched = touches(cfg, mod, carried);
      const reach = new Set(touched.hits);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [owner, names] of touched.refs) {
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
      if (reach.size > 0) doors.add(mod.key);
      reaching.set(mod.key, exported);
      handoffs.set(
        mod.key,
        touched.handoffs
          .filter((h) => !h.local || reach.has(h.name))
          .map((h) => `${mod.key}: ${h.name} ${h.how} in ${h.owner || 'module code'}`),
      );
      const gates = new Set(cfg.gates[mod.key] ?? []);
      const next = new Set([...exported].filter((n) => !gates.has(n)));
      const before = carried.get(mod.key) ?? new Set<string>();
      if (next.size !== before.size || [...next].some((n) => !before.has(n))) {
        carried.set(mod.key, next);
        changed = true;
      }
    }
  }
  return { doors: [...doors].sort(), reaching, modules, handoffs };
}
