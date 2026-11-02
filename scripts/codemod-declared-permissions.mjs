#!/usr/bin/env node
// One-off codemod for ISS-824 (REQ-12 BC-20): a route whose handler's first permission check is a
// fixed permission on the project or organization its own path parameter names declares that check
// where it is mounted (`requiresOnParam`), and the handler's call goes. Every other route is left as
// it is and reported with why. Deleted by the commit that finishes the sweep it serves.
//
//   node scripts/codemod-declared-permissions.mjs [--write [--hoist]] [--only <dir>[,<dir>...]]
//
// Without --write it only reports. Each line: REWROTE or SKIP, the file and line, the route, and the
// permission or the reason.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages', 'core', 'src');
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const CHECKS = new Set(['requireCan', 'requireHeld', 'requireOrgCan', 'requireOrgHeld']);
const DECLARED = /\brequires(OnParam|OnResolved|NoPermission|Self|Public)\(/;

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const onlyAt = argv.indexOf('--only');
const only = onlyAt === -1 ? null : argv[onlyAt + 1].split(',');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')
      ? [path]
      : [];
  });
}

const text = (node, sf) => node.getText(sf);
const unwrapAwait = (e) => (ts.isAwaitExpression(e) ? e.expression : e);
const calleeName = (call) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : null;

/** `c.req.valid('param')` */
function isValidParam(e) {
  return (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    e.expression.name.text === 'valid' &&
    e.arguments.length === 1 &&
    ts.isStringLiteral(e.arguments[0]) &&
    e.arguments[0].text === 'param'
  );
}

/** The path parameter a handler-local identifier holds, from its destructuring or assignment. */
function paramBindings(body) {
  const out = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrapAwait(node.initializer);
      if (isValidParam(init) && ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const prop = el.propertyName ? el.propertyName.text : el.name.text;
          if (ts.isIdentifier(el.name)) out.set(el.name.text, prop);
        }
      } else if (
        ts.isPropertyAccessExpression(init) &&
        isValidParam(init.expression) &&
        ts.isIdentifier(node.name)
      ) {
        out.set(node.name.text, init.name.text);
      } else if (
        ts.isCallExpression(init) &&
        ts.isPropertyAccessExpression(init.expression) &&
        init.expression.name.text === 'param' &&
        init.arguments.length === 1 &&
        ts.isStringLiteral(init.arguments[0]) &&
        ts.isIdentifier(node.name)
      ) {
        out.set(node.name.text, init.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/** The path parameter an expression names, or null. */
function paramOf(e, bindings) {
  if (ts.isIdentifier(e)) return bindings.get(e.text) ?? null;
  if (ts.isPropertyAccessExpression(e) && isValidParam(e.expression)) return e.name.text;
  return null;
}

/** Whether a statement holds a permission check anywhere in it. */
function holdsCheck(stmt) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && CHECKS.has(calleeName(n))) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(stmt);
  return found;
}

/** `const access = await loadProjectAccess(X, ...)` -> { name, target } */
function accessLoad(stmt) {
  if (!ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) return null;
  const d = stmt.declarationList.declarations[0];
  if (!ts.isIdentifier(d.name) || !d.initializer) return null;
  const call = unwrapAwait(d.initializer);
  if (!ts.isCallExpression(call) || calleeName(call) !== 'loadProjectAccess') return null;
  return { name: d.name.text, target: call.arguments[0] };
}

const isFixed = (e) => e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e));

/**
 * The handler's first permission check, as { permission, target, remove: [stmts] }, or { skip }.
 * Only a check that is a statement of the handler body itself counts: one nested in a branch is
 * conditional, and so is not the action's permission.
 */
function firstCheck(body, sf) {
  const stmts = body.statements;
  for (const [i, stmt] of stmts.entries()) {
    const load = accessLoad(stmt);
    if (load) {
      const next = stmts[i + 1];
      const call = next && ts.isExpressionStatement(next) && unwrapAwait(next.expression);
      if (
        call &&
        ts.isCallExpression(call) &&
        calleeName(call) === 'requireHeld' &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === load.name
      ) {
        if (call.arguments.length > 2) return { skip: 'the check names its act (an act argument)' };
        if (!isFixed(call.arguments[1])) return { skip: 'the permission is computed, not a fixed string' };
        const usedLater = stmts
          .slice(i + 2)
          .some((s) => new RegExp(`\\b${load.name}\\b`).test(text(s, sf)));
        return {
          permission: call.arguments[1].text,
          target: load.target,
          remove: usedLater ? [next] : [stmt, next],
          org: false,
        };
      }
      if (holdsCheck(stmt) || (next && holdsCheck(next) && !usedAfter(load, stmts, i)))
        return { skip: 'the access read is checked in a shape the codemod does not take' };
      // the access read without a check beside it: keep looking
      continue;
    }
    if (!holdsCheck(stmt)) continue;
    if (!ts.isExpressionStatement(stmt)) {
      return { skip: 'the first check is inside a declaration or branch, not a statement of its own' };
    }
    const call = unwrapAwait(stmt.expression);
    if (!ts.isCallExpression(call)) return { skip: 'the first check is nested in another expression' };
    const name = calleeName(call);
    if (name === 'requireCan' || name === 'requireOrgCan') {
      if (call.arguments.length > 3) return { skip: 'the check names its act (an act argument)' };
      const [, perm, resource] = call.arguments;
      if (!isFixed(perm)) return { skip: 'the permission is computed, not a fixed string' };
      if (
        !resource ||
        !ts.isCallExpression(resource) ||
        !['projectResource', 'orgResource'].includes(calleeName(resource))
      )
        return { skip: 'the resource is not projectResource/orgResource of an id' };
      return {
        permission: perm.text,
        target: resource.arguments[0],
        remove: [stmt],
        org: name === 'requireOrgCan',
      };
    }
    if (name === 'requireHeld') {
      const [facts, perm] = call.arguments;
      if (call.arguments.length > 2) return { skip: 'the check names its act (an act argument)' };
      if (!isFixed(perm)) return { skip: 'the permission is computed, not a fixed string' };
      const load = facts && unwrapAwait(facts);
      if (load && ts.isCallExpression(load) && calleeName(load) === 'loadProjectAccess') {
        return { permission: perm.text, target: load.arguments[0], remove: [stmt], org: false };
      }
      return { skip: 'requireHeld on access read elsewhere (a helper or an earlier row)' };
    }
    return { skip: `the first check is ${name}, an org check on facts read elsewhere` };
  }
  return { skip: 'no permission check in the handler body (a service or helper checks)' };
}

function usedAfter(load, stmts, i) {
  return stmts.slice(i + 1).some((s) => new RegExp(`\\b${load.name}\\b`).test(s.getText()));
}

/** The index of the argument the declaration goes after: the path validator, or none. */
function paramValidatorIndex(args, sf) {
  for (const [i, a] of args.entries()) {
    if (i === 0) continue;
    const t = text(a, sf);
    if (/^zValidator\(\s*'param'/.test(t) || /^\w*[pP]aram(Schema|Validator)?$/.test(t)) return i;
    if (/^reqAnd\(/.test(t) || /^paramOf\(/.test(t)) return i;
  }
  return -1;
}

function importPath(file) {
  const rel = relative(dirname(file), join(SRC, 'permissions', 'index.js')).replaceAll('\\', '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function addImport(src, file) {
  const from = importPath(file);
  const re = new RegExp(`import \\{([^}]*)\\} from '${from.replaceAll('.', '\\.')}';`);
  const m = re.exec(src);
  if (m) {
    const names = m[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    if (names.includes('requiresOnParam')) return src;
    return src.replace(m[0], `import { ${[...names, 'requiresOnParam'].join(', ')} } from '${from}';`);
  }
  const last = [...src.matchAll(/^import [^;]*;\n/gm)].at(-1);
  const at = last ? last.index + last[0].length : 0;
  return `${src.slice(0, at)}import { requiresOnParam } from '${from}';\n${src.slice(at)}`;
}

// A declaration used three times or more in one file is named once, so the routes stay one line each
// and the file inside its line cap: `const READ = requiresOnParam('project.read', 'id');`.
const hoistOnly = process.argv.includes('--hoist');
function hoistName(permission, param) {
  const [scope, act] = permission.split('.');
  const base = scope === 'project' ? act.toUpperCase() : `${scope}_${act}`.toUpperCase().replace(/-/g, '_');
  const usual = scope === 'org' ? param === 'orgId' : param === 'id' || param === 'projectId';
  return usual ? base : `${base}_ON_${param.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
}
function hoist(src, file) {
  const counts = new Map();
  for (const m of src.matchAll(/requiresOnParam\('([\w.-]+)', '(\w+)'\)/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const named = [...counts]
    .filter(([, n]) => n >= 3)
    .map(([call]) => {
      const [, permission, param] = call.match(/requiresOnParam\('([\w.-]+)', '(\w+)'\)/);
      return { call, name: hoistName(permission, param) };
    })
    .filter(({ name }) => !new RegExp(`\\b${name}\\b`).test(src));
  if (named.length === 0) return src;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const first = sf.statements.find(
    (st) => !ts.isImportDeclaration(st) && named.some(({ call }) => st.getText(sf).includes(call)),
  );
  const at = first.getStart(sf);
  let rest = src.slice(at);
  for (const { call, name } of named) rest = rest.split(call).join(name);
  const consts = named.map(({ call, name }) => `const ${name} = ${call};\n`).join('');
  return `${src.slice(0, at)}${consts}\n${rest}`;
}

const report = [];
for (const file of files(SRC)) {
  const rel = relative(SRC, file);
  const module = rel.split('/')[0];
  if (only && !only.includes(module)) continue;
  if (rel.startsWith('permissions/') || rel.startsWith('api-contract/')) continue;
  const src = readFileSync(file, 'utf8');
  if (!/\.(get|post|put|patch|delete)\(\s*['`]\//.test(src)) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      VERBS.has(node.expression.name.text) &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith('/')
    ) {
      const route = `${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const where = `${rel}:${line} ${route}`;
      const out = (kind, what) => report.push({ kind, module, where, what });
      const args = node.arguments;
      const handler = args[args.length - 1];
      const middle = args.slice(1, -1).map((a) => text(a, sf));
      if (middle.some((t) => DECLARED.test(t)) || middle.some((t) => /^\.\.\./.test(t))) {
        out('SKIP', middle.some((t) => DECLARED.test(t)) ? 'already declares' : 'middlewares spread from an array');
      } else if (!(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        out('SKIP', 'the handler is not written inline');
      } else if (!ts.isBlock(handler.body)) {
        out('SKIP', 'the handler is an expression, with no check of its own');
      } else {
        const found = firstCheck(handler.body, sf);
        const params = [...node.arguments[0].text.matchAll(/:(\w+)/g)].map((m) => m[1]);
        const paramName = found.target ? paramOf(found.target, paramBindings(handler.body)) : null;
        const pv = paramValidatorIndex(args, sf);
        if (found.skip) out('SKIP', found.skip);
        else if (!paramName || !params.includes(paramName))
          out('SKIP', `the check is on ${text(found.target, sf)}, not a path parameter (a resolved project)`);
        else if (found.org !== found.permission.startsWith('org.'))
          out('SKIP', 'an org check on a project permission, or the other way');
        else {
          // with no path validator the handler read the raw parameter, and the declaration reads the same
          out(
            'REWROTE',
            `requiresOnParam('${found.permission}', '${paramName}')${pv === -1 ? ' (after the path: no validator)' : ''}`,
          );
          edits.push({
            at: args[pv === -1 ? 0 : pv].getEnd(),
            insert: ` requiresOnParam('${found.permission}', '${paramName}'),`,
          });
          for (const stmt of found.remove) {
            edits.push({ from: stmt.getFullStart(), to: stmt.getEnd(), insert: '' });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (write && edits.length > 0) {
    let next = src;
    for (const e of edits.sort((a, b) => (b.from ?? b.at) - (a.from ?? a.at))) {
      if (e.from !== undefined) next = next.slice(0, e.from) + e.insert + next.slice(e.to);
      else {
        // after the validator's own trailing comma
        const comma = next.indexOf(',', e.at);
        next = next.slice(0, comma + 1) + e.insert + next.slice(comma + 1);
      }
    }
    writeFileSync(file, hoist(addImport(next, file), file));
  } else if (write && hoistOnly) {
    const next = hoist(src, file);
    if (next !== src) writeFileSync(file, next);
  }
}

for (const r of report) console.log(`${r.kind.padEnd(7)} ${r.where} — ${r.what}`);
const per = new Map();
const reasons = new Map();
for (const r of report) {
  const m = per.get(r.module) ?? { REWROTE: 0, SKIP: 0 };
  m[r.kind] += 1;
  per.set(r.module, m);
  if (r.kind === 'SKIP') reasons.set(r.what, (reasons.get(r.what) ?? 0) + 1);
}
console.log('\nper module (rewrote / skipped):');
for (const [m, n] of [...per].sort()) console.log(`  ${m}: ${n.REWROTE} / ${n.SKIP}`);
console.log('\nskip reasons:');
for (const [w, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${w}`);
