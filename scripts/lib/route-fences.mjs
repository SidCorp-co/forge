// Which registered route reaches the PAT fence, one route at a time.
//
// The fence is ONE function: the read of the fenced project ids out of AsyncLocalStorage. A
// route is fenced when a function its registration passes — a handler, or a middleware that the
// same router registered before it on a pattern covering it — calls, through any depth of calls
// the type checker can resolve to a declaration in this package, that function. Reachability is
// decided per FUNCTION, never per module: a file holding one fenced function lends nothing to
// its neighbours.
//
// A call the checker cannot resolve reaches nothing, so every gap in this proof errs red.

import { join, relative } from 'node:path';
import ts from 'typescript';

const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'on']);
const REGISTRARS = new Set([...VERBS, 'use', 'route']);

/** Hono's own `mergePath`, so a static path is spelt exactly as `app.routes` spells it. */
export function mergePath(base, sub) {
  const head = base.startsWith('/') ? '' : '/';
  if (sub === '/') return `${head}${base}`;
  const glue = base.endsWith('/') ? '' : '/';
  return `${head}${base}${glue}${sub.startsWith('/') ? sub.slice(1) : sub}`;
}

function segmentsOf(path) {
  return path.split('/').filter((s) => s.length > 0);
}

/** Whether a middleware pattern covers a route path, as Hono's router matches one. */
export function patternCovers(pattern, path) {
  const want = segmentsOf(pattern);
  const have = segmentsOf(path);
  for (const [i, segment] of want.entries()) {
    if (i === want.length - 1 && segment.endsWith('*')) {
      return have.slice(i).join('/').startsWith(segment.slice(0, -1));
    }
    const actual = have[i];
    if (actual === undefined) return false;
    if (!segment.startsWith(':') && segment !== actual) return false;
  }
  return want.length === have.length;
}

function loadProgram(coreDir, roots) {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} };
  const config = ts.getParsedCommandLineOfConfigFile(join(coreDir, 'tsconfig.json'), {}, host);
  if (!config) throw new Error(`could not read ${join(coreDir, 'tsconfig.json')}`);
  const options = { ...config.options, incremental: false, noEmit: true };
  delete options.tsBuildInfoFile;
  return ts.createProgram({ rootNames: roots.map((r) => join(coreDir, r)), options });
}

/**
 * The fence proof over the router tree `appName` in `entry` roots.
 *
 * Returns every registration reached from the root with its full path, whether it reaches
 * `fence`, and the calls on a router whose path argument this proof cannot read.
 */
export function routeFences({ coreDir, entry, appName, fence }) {
  const program = loadProgram(coreDir, [entry, join('src', fence.file)]);
  const checker = program.getTypeChecker();
  const srcDir = join(coreDir, 'src');
  const ours = (sf) => !sf.isDeclarationFile && !relative(srcDir, sf.fileName).startsWith('..');
  const where = (node) => {
    const sf = node.getSourceFile();
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return { file: relative(srcDir, sf.fileName), line };
  };

  const resolve = (node) => {
    let sym = checker.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym ?? null;
  };

  const fenceFile = join(srcDir, fence.file);
  const isFence = (decl) =>
    decl.getSourceFile().fileName === fenceFile &&
    ts.isFunctionDeclaration(decl) &&
    decl.name?.text === fence.name;
  const fenceFound = program
    .getSourceFile(fenceFile)
    ?.statements.some((s) => ts.isFunctionDeclaration(s) && isFence(s));
  if (!fenceFound) throw new Error(`the fence ${fence.name} is not declared in ${fence.file}`);

  const byReceiver = new Map();
  for (const sf of program.getSourceFiles()) {
    if (!ours(sf)) continue;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        REGISTRARS.has(node.expression.name.text)
      ) {
        const sym = resolve(node.expression.expression);
        if (sym) byReceiver.set(sym, [...(byReceiver.get(sym) ?? []), node]);
      } else if (ts.isCallExpression(node)) {
        for (const arg of node.arguments.filter(ts.isIdentifier)) {
          const sym = resolve(arg);
          if (sym) byReceiver.set(sym, [...(byReceiver.get(sym) ?? []), node]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const memo = new Map();
  function reachesDecl(decl) {
    if (isFence(decl)) return true;
    if (!ours(decl.getSourceFile())) return false;
    if (memo.has(decl)) return memo.get(decl);
    memo.set(decl, false);
    let hit = false;
    if (ts.isFunctionLike(decl)) hit = reachesBody(decl);
    else if (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl)) {
      hit = decl.initializer ? reachesExpr(decl.initializer) : false;
    } else if (ts.isShorthandPropertyAssignment(decl)) {
      const value = checker.getShorthandAssignmentValueSymbol(decl);
      hit = (value?.declarations ?? []).some(reachesDecl);
    }
    memo.set(decl, hit);
    return hit;
  }

  function reachesSymbolOf(node) {
    return (resolve(node)?.declarations ?? []).some(reachesDecl);
  }

  function reachesBody(fn) {
    let hit = false;
    const visit = (node) => {
      if (hit) return;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (reachesSymbolOf(node.expression)) hit = true;
        for (const arg of node.arguments ?? []) {
          if (!hit && ts.isIdentifier(arg) && reachesCallable(arg)) hit = true;
        }
      }
      if (!hit) ts.forEachChild(node, visit);
    };
    if (fn.body) visit(fn.body);
    return hit;
  }

  function reachesCallable(ident) {
    return (resolve(ident)?.declarations ?? []).some((d) =>
      ts.isFunctionDeclaration(d) ||
      (ts.isVariableDeclaration(d) &&
        d.initializer !== undefined &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
        ? reachesDecl(d)
        : false,
    );
  }

  function reachesExpr(expr) {
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return reachesBody(expr);
    if (ts.isCallExpression(expr)) {
      return reachesSymbolOf(expr.expression) || expr.arguments.some((a) => reachesExpr(a));
    }
    if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return reachesSymbolOf(expr);
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
      return reachesExpr(expr.expression);
    }
    return false;
  }

  function literalPaths(arg) {
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return [arg.text];
    if (!ts.isIdentifier(arg)) return null;
    const decl = resolve(arg)?.declarations?.[0];
    const loop = decl?.parent?.parent;
    if (!decl || !loop || !ts.isForOfStatement(loop)) return null;
    if (!ts.isArrayLiteralExpression(loop.expression)) return null;
    const out = loop.expression.elements.map((e) =>
      ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null,
    );
    return out.includes(null) ? null : out;
  }

  const registrations = [];
  const unreadable = [];
  const walking = new Set();

  /** The parameter a router is handed to when a function registers routes on it. */
  function delegateOf(call, sym) {
    const index = call.arguments.findIndex((a) => ts.isIdentifier(a) && resolve(a) === sym);
    const decl = resolve(call.expression)?.declarations?.find(
      (d) => ts.isFunctionLike(d) && ours(d.getSourceFile()),
    );
    const param = decl?.parameters?.[index];
    return param && ts.isIdentifier(param.name) ? checker.getSymbolAtLocation(param.name) : null;
  }

  function walk(sym, prefix, inherited = []) {
    if (walking.has(sym)) return;
    walking.add(sym);
    const middleware = [...inherited];
    const calls = [...(byReceiver.get(sym) ?? [])].sort(
      (a, b) =>
        a.getSourceFile().fileName.localeCompare(b.getSourceFile().fileName) ||
        a.getStart() - b.getStart(),
    );
    for (const call of calls) {
      if (
        !ts.isPropertyAccessExpression(call.expression) ||
        resolve(call.expression.expression) !== sym
      ) {
        const param = delegateOf(call, sym);
        if (param) walk(param, prefix, middleware);
        continue;
      }
      const verb = call.expression.name.text;
      const args = [...call.arguments];
      let methods = [verb.toUpperCase()];
      if (verb === 'on') {
        const m = args.shift();
        const list = m && ts.isArrayLiteralExpression(m) ? [...m.elements] : m ? [m] : [];
        methods = list.map((e) => (ts.isStringLiteral(e) ? e.text.toUpperCase() : null));
        if (methods.includes(null) || methods.length === 0) {
          unreadable.push({
            ...where(call),
            why: 'an .on() whose methods are not string literals',
          });
          continue;
        }
      }
      const first = args[0];
      let subs = first ? literalPaths(first) : null;
      if (subs) args.shift();
      else if (verb === 'use') subs = ['*'];
      if (!subs) {
        unreadable.push({ ...where(call), why: `a .${verb}() whose path is not a literal` });
        continue;
      }
      if (verb === 'route') {
        const child = args[0] ? resolve(args[0]) : null;
        if (!child) {
          unreadable.push({ ...where(call), why: 'a .route() whose router cannot be resolved' });
          continue;
        }
        for (const sub of subs) walk(child, mergePath(prefix, sub), middleware);
        continue;
      }
      const fenced = args.some((a) => reachesExpr(a));
      for (const sub of subs) {
        const path = mergePath(prefix, sub);
        if (verb === 'use' || verb === 'all') {
          middleware.push({ pattern: path, fenced });
          if (verb === 'use') continue;
        }
        const guard = middleware.find((m) => m.fenced && patternCovers(m.pattern, path));
        for (const method of methods) {
          registrations.push({
            method,
            path,
            ...where(call),
            fenced: fenced || guard !== undefined,
          });
        }
      }
    }
    walking.delete(sym);
  }

  const entryFile = program.getSourceFile(join(coreDir, entry));
  const root = entryFile?.statements
    .filter(ts.isVariableStatement)
    .flatMap((s) => [...s.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === appName);
  if (!root) throw new Error(`no \`${appName}\` declared in ${entry}`);
  walk(checker.getSymbolAtLocation(root.name), '/');
  return { registrations, unreadable };
}
