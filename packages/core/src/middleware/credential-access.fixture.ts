// Every access core's source makes to a request, read by TYPE through the TypeScript checker, for
// credential-doors.test.ts. A value is a request when its static type is a carrier
// (credential-ast.fixture.ts: a Hono context or request, a fetch Request, Headers, a URL or its
// query, a Node IncomingMessage or its headers, a ws socket), whatever it is named and however it
// was reached: through a union, a subclass or a type parameter's constraint. Each use of one is:
//   - a member the surface table classifies: an input read by name, a whole read, or none;
//   - a flow into another type: a carrier is read where it lands; any other object type is read as
//     a slice of the carrier, member by member, so a helper typed `{ get(k: 'userId') }` reads
//     exactly what that type exposes; a package's function is a whole read, classified per module;
//   - a refusal naming what the scan cannot read: a member missing from the table, a by-name member
//     taken as a value, a carrier cast or handed to `unknown`, `any` or a bare type parameter.
// Nothing passes unread.

import { dirname, join, relative, sep } from 'node:path';
import ts from 'typescript';
import {
  type Access,
  CARRIERS,
  type Carrier,
  calleeName,
  callOf,
  type FrameworkImport,
  frameworkImports,
  instanceShape,
  isValueExpression,
  ownerName,
  PACKAGE_DIRS,
  packageOf,
  passesThrough,
  type Role,
  type Surface,
  unwrapped,
} from './credential-ast.fixture.js';

export interface Scan {
  files: Map<string, ts.SourceFile>;
  accesses: Map<string, Access[]>;
  frameworkImports: Map<string, FrameworkImport[]>;
}

const EVENTS_WITH_CONTENT = new Set(['message', 'data']);
const OPAQUE = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never;
const K = ts.SyntaxKind;
const COMPARISONS = [
  K.EqualsEqualsEqualsToken,
  K.ExclamationEqualsEqualsToken,
  K.EqualsEqualsToken,
  K.ExclamationEqualsToken,
];
const DEFAULTING = [K.QuestionQuestionToken, K.BarBarToken, K.AmpersandAmpersandToken];

/** The program over core's src (no tests, no fixtures), with core's own compiler options. */
function programOver(src: string): ts.Program {
  const core = dirname(src);
  const cfg = ts.readConfigFile(join(core, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, core);
  const roots = parsed.fileNames.filter(
    (f) => f.startsWith(`${src}/`) && !/\.(test|fixture)\.ts$/.test(f),
  );
  const { tsBuildInfoFile: _, ...options } = parsed.options;
  return ts.createProgram({
    rootNames: roots,
    options: { ...options, noEmit: true, incremental: false, declaration: false, sourceMap: false },
  });
}

/** Every request access in core's src, and every hono-family import, by module. */
export function scanAccesses(src: string, surface: Surface): Scan {
  const root = src.split(sep).join('/');
  const program = programOver(root);
  const scan = new AccessScan(program.getTypeChecker(), surface);
  const found: Scan = { files: new Map(), accesses: new Map(), frameworkImports: new Map() };
  for (const sf of program.getSourceFiles()) {
    const path = sf.fileName.split(sep).join('/');
    if (!path.startsWith(`${root}/`) || sf.isDeclarationFile) continue;
    if (/\.(test|fixture)\.ts$/.test(path)) continue;
    const key = relative(root, path).split(sep).join('/');
    const read = scan.file(key, sf);
    found.files.set(key, sf);
    found.accesses.set(key, read.accesses);
    found.frameworkImports.set(key, read.imports);
  }
  return found;
}

class AccessScan {
  private readonly checker: ts.TypeChecker;
  private readonly surface: Surface;
  private readonly cache = new Map<ts.Type, Carrier | null>();
  private key = '';
  private sf: ts.SourceFile | undefined;
  private out: Access[] = [];
  private imports: FrameworkImport[] = [];

  constructor(checker: ts.TypeChecker, surface: Surface) {
    this.checker = checker;
    this.surface = surface;
  }

  file(key: string, sf: ts.SourceFile) {
    this.key = key;
    this.sf = sf;
    this.out = [];
    this.imports = [];
    this.visit(sf);
    return { accesses: this.out, imports: this.imports };
  }

  private visit = (node: ts.Node): void => {
    this.imports.push(...frameworkImports(node));
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (isValueExpression(node)) {
      const carrier = this.carrierOf(this.checker.getTypeAtLocation(node));
      if (carrier) this.use(node, carrier);
    }
    ts.forEachChild(node, this.visit);
  };

  /** The carrier a type is, through unions, intersections, base classes and constraints. */
  private carrierOf(type: ts.Type, depth = 0): Carrier | null {
    const cached = this.cache.get(type);
    if (cached !== undefined) return cached;
    let found: Carrier | null = null;
    if (depth < 8) {
      if (type.isUnionOrIntersection()) {
        for (const t of type.types) found ??= this.carrierOf(t, depth + 1);
      } else if (type.flags & ts.TypeFlags.TypeParameter) {
        const constraint = this.checker.getBaseConstraintOfType(type);
        if (constraint && constraint !== type) found = this.carrierOf(constraint, depth + 1);
      } else {
        found = this.named(type);
        const shape = instanceShape(type);
        for (const base of found || !shape ? [] : this.checker.getBaseTypes(shape)) {
          found ??= this.carrierOf(base, depth + 1);
        }
      }
    }
    this.cache.set(type, found);
    return found;
  }

  /** The carrier an instance type names by its declaration; null for a constructor or namesake. */
  private named(type: ts.Type): Carrier | null {
    const sym = instanceShape(type) ? type.getSymbol() : undefined;
    const name = sym?.getName();
    if (!sym || !name || !(name in CARRIERS)) return null;
    const dirs = PACKAGE_DIRS[CARRIERS[name as Carrier]] ?? [];
    const declared = (sym.getDeclarations() ?? []).some((d) => {
      const file = d.getSourceFile().fileName.split(sep).join('/');
      return dirs.some((dir) => file.includes(dir));
    });
    return declared ? (name as Carrier) : null;
  }

  private carrierAt(node: ts.Node): Carrier | null {
    return this.carrierOf(this.checker.getTypeAtLocation(node));
  }

  /** The single string a node's type is, through casts; null when it is not one literal. */
  private literalName(node: ts.Node | undefined): string | null {
    const at = unwrapped(node);
    if (!at) return null;
    if (ts.isStringLiteralLike(at)) return at.text;
    const type = this.checker.getTypeAtLocation(at);
    return type.isStringLiteral() ? type.value : null;
  }

  /** Whether a value of this type can hold a free string, where a credential could ride. */
  private holdsString(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false;
    seen.add(type);
    if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral | OPAQUE)) return true;
    if (type.isUnionOrIntersection()) return type.types.some((t) => this.holdsString(t, seen));
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    const c = this.checker;
    if (c.getIndexInfosOfType(type).some((i) => this.holdsString(i.type, seen))) return true;
    if (c.isArrayType(type) || c.isTupleType(type)) {
      return c.getTypeArguments(type as ts.TypeReference).some((t) => this.holdsString(t, seen));
    }
    return type.getProperties().some((p) => this.holdsString(c.getTypeOfSymbol(p), seen));
  }

  private text(node: ts.Node): string {
    return node.getText(this.sf).replace(/\s+/g, ' ');
  }

  private input(role: string, name: string, node: ts.Node) {
    const named = role === 'header' ? name.toLowerCase() : name;
    this.out.push({ kind: 'input', key: `${role}:${named}`, node });
  }

  private whole(what: string, node: ts.Node) {
    this.out.push({ kind: 'whole', key: `${this.key} ${what} in ${ownerName(node)}`, node });
  }

  private refuse(why: string, node: ts.Node) {
    const key = `${this.key}: ${why} (${this.text(node)}) in ${ownerName(node)}`;
    this.out.push({ kind: 'refused', key, node });
  }

  /** How a carrier-typed expression is used where it stands. */
  private use(expr: ts.Expression, carrier: Carrier) {
    let at: ts.Node = expr;
    while (passesThrough(at.parent)) at = at.parent;
    const p = at.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === at) {
      return this.member(carrier, p.name.text, p.name, p);
    }
    if (ts.isElementAccessExpression(p) && p.expression === at) return this.element(carrier, p);
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === at) return;
    if (ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) return this.cast(carrier, p);
    if (ts.isVariableDeclaration(p) && p.initializer === at) return this.declared(carrier, at, p);
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) return this.handoff(carrier, at, p);
    if (ts.isBinaryExpression(p)) return this.binary(carrier, at, p);
    if (ts.isConditionalExpression(p) && p.condition === at) return;
    if (ts.isConditionalExpression(p) || ts.isAwaitExpression(p)) {
      return this.carrierAt(p) ? undefined : this.refuse(`${carrier} flows into a non-carrier`, p);
    }
    if (ts.isPrefixUnaryExpression(p) && p.operator === K.ExclamationToken) return;
    if (ts.isTypeOfExpression(p) || ts.isExpressionStatement(p) || ts.isIfStatement(p)) return;
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === at)) {
      return this.returned(carrier, at, p);
    }
    if (
      ts.isPropertyAssignment(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isArrayLiteralExpression(p)
    ) {
      return this.placed(carrier, at as ts.Expression, p);
    }
    if ((ts.isParameter(p) || ts.isPropertyDeclaration(p)) && p.initializer === at && p.type) {
      return this.flow(carrier, at, this.checker.getTypeFromTypeNode(p.type), 'assigned to');
    }
    if (ts.isForOfStatement(p) && p.expression === at) return this.whole(`${carrier} iterated`, p);
    if (ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) {
      return this.refuse(`${carrier} spread`, p);
    }
    if (ts.isTemplateSpan(p)) return this.refuse(`${carrier} written into a string`, p);
    this.refuse(`${carrier} used as ${ts.SyntaxKind[p.kind]}`, p);
  }

  /** `carrier[name]`: a member by its literal name; a computed one only on a header record. */
  private element(carrier: Carrier, p: ts.ElementAccessExpression) {
    const name = this.literalName(p.argumentExpression);
    if (name !== null) return this.member(carrier, name, p.argumentExpression, p);
    if (carrier === 'IncomingHttpHeaders') {
      return this.whole(`${carrier}[${this.text(p.argumentExpression)}]`, p);
    }
    this.refuse(`${carrier} read by a computed member`, p);
  }

  /** A member of a carrier, read at `at` (a property, an element, or a binding name). */
  private member(carrier: Carrier, name: string, at: ts.Node, access: ts.Node) {
    if (carrier === 'IncomingHttpHeaders') return this.input('header', name, at);
    const role = this.roleOf(carrier, name, access);
    if (role === null || role === 'none' || role === 'carrier') return;
    if (role === 'whole') return this.whole(`${carrier}.${name}`, at);
    const call = callOf(access);
    if (!call) return this.refuse(`${carrier}.${name} taken as a value, not called`, at);
    this.called(carrier, name, role, call);
  }

  /** The table's role for a member; null for a field core itself added to a carrier's type. */
  private roleOf(carrier: Carrier, name: string, at: ts.Node): Role | null {
    const role = this.surface[carrier].get(name);
    if (role !== undefined) return role;
    const sym = ts.isPropertyAccessExpression(at)
      ? this.checker.getSymbolAtLocation(at.name)
      : undefined;
    const home = sym?.getDeclarations()?.[0]?.getSourceFile().fileName;
    if (home && !/[\\/]node_modules[\\/]/.test(home)) return null;
    this.refuse(`${carrier}.${name} is not in the surface table`, at);
    return null;
  }

  /** A called member that reads by name, by validated target, or by event. */
  private called(carrier: Carrier, name: string, role: Role, call: ts.CallExpression) {
    const arg = call.arguments[0];
    const what = `${carrier}.${name}`;
    if (role === 'event') {
      const event = this.literalName(arg);
      if (event === null || EVENTS_WITH_CONTENT.has(event)) {
        this.whole(`${what}(${event ?? (arg ? this.text(arg) : '')})`, call);
      }
      return;
    }
    if (!arg) return this.whole(`${what}()`, call);
    const named = this.literalName(arg);
    if (named === null) return this.whole(`${what}(${this.text(arg)})`, call);
    if (role === 'fields') return this.fields(what, named, call);
    this.input(role, named, call);
  }

  /**
   * Each field of a validated target that can hold a free string, from every member of a union;
   * a target whose shape takes any key, or names none the checker can see, is a whole read too.
   */
  private fields(what: string, target: string, call: ts.CallExpression) {
    const c = this.checker;
    const output = c.getNonNullableType(c.getTypeAtLocation(call));
    const parts = output.isUnion() ? output.types : [output];
    const strings = new Set<string>();
    let open = false;
    for (const part of parts) {
      const props = part.flags & OPAQUE ? [] : part.getProperties();
      if (props.length === 0 || c.getIndexInfosOfType(part).length > 0) open = true;
      for (const p of props) if (this.holdsString(c.getTypeOfSymbol(p))) strings.add(p.getName());
    }
    if (open) this.whole(`${what}(${target})`, call);
    for (const name of strings) this.input('field', `${target}:${name}`, call);
  }

  /** A carrier read under a declared type: a carrier is read where it lands, else as a slice. */
  private flow(carrier: Carrier, at: ts.Node, into: ts.Type, via: string) {
    this.slice(carrier, this.checker.getTypeAtLocation(at), at, into, via, 0);
  }

  /** The members a declared type exposes of a carrier whose own type is `from`. */
  private slice(
    carrier: Carrier,
    from: ts.Type,
    at: ts.Node,
    into: ts.Type,
    via: string,
    depth: number,
  ) {
    const c = this.checker;
    const target = c.getNonNullableType(into);
    if (this.carrierOf(target)) return;
    const shown = c.typeToString(target);
    if (target.flags & (OPAQUE | ts.TypeFlags.TypeParameter)) {
      return this.refuse(`${carrier} ${via} ${shown}, which the scan cannot read`, at);
    }
    if (target.isUnion()) {
      for (const t of target.types) this.slice(carrier, from, at, t, via, depth + 1);
      return;
    }
    const where = `${via} ${shown}`;
    for (const prop of target.getProperties()) {
      const name = prop.getName();
      const role = carrier === 'IncomingHttpHeaders' ? 'header' : this.surface[carrier].get(name);
      if (role === undefined) {
        this.refuse(`${carrier}.${name} is not in the surface table, ${where}`, at);
      } else if (carrier === 'IncomingHttpHeaders') {
        this.input('header', name, at);
      } else if (role === 'carrier') {
        const next = this.yields(from, name);
        if (!next || depth > 4) this.refuse(`${carrier}.${name} yields no carrier, ${where}`, at);
        else this.slice(next.carrier, next.type, at, c.getTypeOfSymbol(prop), via, depth + 1);
      } else if (role === 'whole' || role === 'event' || role === 'fields') {
        this.whole(`${carrier}.${name} ${where}`, at);
      } else if (role !== 'none') {
        this.sliced(carrier, name, role, c.getTypeOfSymbol(prop), at, where);
      }
    }
  }

  /** A by-name member a slice exposes: each literal name its parameter admits, else whole. */
  private sliced(c: Carrier, name: string, role: Role, type: ts.Type, at: ts.Node, where: string) {
    const names = type.getCallSignatures().flatMap((sig) => {
      const first = sig.getParameters()[0];
      if (!first) return [null];
      const t = this.checker.getTypeOfSymbol(first);
      return (t.isUnion() ? t.types : [t]).map((p) => (p.isStringLiteral() ? p.value : null));
    });
    if (names.length === 0 || names.includes(null)) {
      return this.whole(`${c}.${name}(…) ${where}`, at);
    }
    for (const n of new Set(names)) if (n !== null) this.input(role, n, at);
  }

  /** The carrier a carrier member yields, and its type, read off the carrier's own type. */
  private yields(host: ts.Type, name: string): { carrier: Carrier; type: ts.Type } | null {
    for (const part of host.isUnionOrIntersection() ? host.types : [host]) {
      const prop = this.checker.getApparentType(part).getProperty(name);
      const type = prop ? this.checker.getTypeOfSymbol(prop) : undefined;
      const carrier = type ? this.carrierOf(type) : null;
      if (carrier && type) return { carrier, type };
    }
    return null;
  }

  /** A cast: read as the type the outermost cast of a chain gives. */
  private cast(carrier: Carrier, node: ts.AsExpression | ts.TypeAssertion) {
    let top: ts.Node = node;
    const castOrWrap = (n: ts.Node) =>
      ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || passesThrough(n);
    while (castOrWrap(top.parent)) top = top.parent;
    const from = this.checker.getTypeAtLocation(node.expression);
    this.slice(carrier, from, top, this.checker.getTypeAtLocation(top), 'cast to', 0);
  }

  /** A carrier bound by a declaration: destructured member by member, or read where it is typed. */
  private declared(carrier: Carrier, at: ts.Node, decl: ts.VariableDeclaration) {
    if (ts.isArrayBindingPattern(decl.name)) {
      return this.refuse(`${carrier} destructured as an array`, decl);
    }
    if (!ts.isObjectBindingPattern(decl.name)) {
      if (!decl.type) return;
      return this.flow(carrier, at, this.checker.getTypeFromTypeNode(decl.type), 'assigned to');
    }
    for (const el of decl.name.elements) {
      const prop = el.propertyName ?? el.name;
      const name = ts.isIdentifier(prop) || ts.isStringLiteralLike(prop) ? prop.text : null;
      if (el.dotDotDotToken) this.refuse(`${carrier} spread into a rest binding`, el);
      else if (name === null) this.refuse(`${carrier} destructured by a computed key`, el);
      else this.member(carrier, name, el, el);
    }
  }

  /** A carrier in a binary expression: a comparison reads nothing, an assignment flows. */
  private binary(carrier: Carrier, at: ts.Node, p: ts.BinaryExpression) {
    const op = p.operatorToken.kind;
    if (op === K.EqualsToken) {
      if (p.left === at) return;
      return this.flow(carrier, at, this.checker.getTypeAtLocation(p.left), 'assigned to');
    }
    if (COMPARISONS.includes(op)) return;
    if ((op === K.InstanceOfKeyword || op === K.AmpersandAmpersandToken) && p.left === at) return;
    if (DEFAULTING.includes(op)) {
      return this.carrierAt(p) ? undefined : this.refuse(`${carrier} flows into a non-carrier`, p);
    }
    this.refuse(`${carrier} used in a ${ts.tokenToString(op) ?? 'binary'} expression`, p);
  }

  /** A carrier returned: read under the function's declared return type, awaited. */
  private returned(carrier: Carrier, at: ts.Node, p: ts.Node) {
    const fn = ts.isArrowFunction(p) ? p : ts.findAncestor(p, ts.isFunctionLike);
    if (!fn || !('type' in fn) || !fn.type) return;
    const declared = this.checker.getTypeFromTypeNode(fn.type);
    this.flow(carrier, at, this.checker.getAwaitedType(declared) ?? declared, 'returned as');
  }

  /** A carrier placed in an object or array literal: read where the literal goes. */
  private placed(carrier: Carrier, at: ts.Expression, p: ts.Node) {
    const literal = (n: ts.Node) =>
      ts.isPropertyAssignment(n) ||
      ts.isShorthandPropertyAssignment(n) ||
      ts.isObjectLiteralExpression(n) ||
      ts.isArrayLiteralExpression(n);
    let top: ts.Node = p;
    while (literal(top.parent)) top = top.parent;
    const call = top.parent;
    if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && this.isPackageCall(call)) {
      return this.whole(`${carrier} handed to ${this.calleeOf(call)}`, call);
    }
    const ctx = this.checker.getContextualType(at);
    if (!ctx) return this.refuse(`${carrier} placed in a literal no type reads`, p);
    this.flow(carrier, at, ctx, 'placed in');
  }

  /** A carrier handed to a function: a package's is a whole read; core's is read as typed. */
  private handoff(carrier: Carrier, arg: ts.Node, call: ts.CallExpression | ts.NewExpression) {
    if (this.isPackageCall(call)) {
      if (this.carrierAt(call)) return;
      return this.whole(`${carrier} handed to ${this.calleeOf(call)}`, call);
    }
    const type = this.checker.getContextualType(arg as ts.Expression);
    if (!type) return this.refuse(`${carrier} handed to ${calleeName(call)} untyped`, arg);
    this.flow(carrier, arg, type, `handed to ${calleeName(call)} as`);
  }

  private isPackageCall(call: ts.CallExpression | ts.NewExpression): boolean {
    const sf = this.checker.getResolvedSignature(call)?.getDeclaration()?.getSourceFile();
    return !sf || sf.isDeclarationFile || /[\\/]node_modules[\\/]/.test(sf.fileName);
  }

  private calleeOf(call: ts.CallExpression | ts.NewExpression): string {
    const decl = this.checker.getResolvedSignature(call)?.getDeclaration();
    return `${packageOf(decl?.getSourceFile().fileName)}:${calleeName(call)}`;
  }
}
