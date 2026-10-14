import { statusToCode } from '../../middleware/error.js';
import { type Finding, openApiPath, type Reference } from '../document/build.js';
import type { RouteEntry } from '../document/registry.js';

/**
 * Every way the reference can fall short of the routes, each as a finding that names the route.
 * `build.ts` reports the ones it meets while building; the rest need the handlers' own text or
 * the source tree, so they are read here.
 */
export type CheckInput = {
  readonly reference: Reference;
  /** Every quoted string the non-test source writes outside a `fail(...)` declaration (`written-codes.fixture.ts`): where a declared error code must be written. */
  readonly written: ReadonlySet<string>;
};

type Read = 'json' | 'query' | 'form' | 'raw' | 'param';

const READS: ReadonlyArray<readonly [RegExp, Read]> = [
  [/\.req\.json\(/, 'json'],
  [/\.req\.(?:query|queries)\(/, 'query'],
  [/\.req\.(?:parseBody|formData)\(/, 'form'],
  [/\.req\.(?:text|arrayBuffer|blob)\(/, 'raw'],
  [/\.req\.param\(/, 'param'],
];

/** Which inputs a handler's own text reads, which is what it enforces by reading. */
export function inputsRead(handlerSource: string): Read[] {
  return READS.filter(([pattern]) => pattern.test(handlerSource)).map(([, read]) => read);
}

function declaredInputs(entry: RouteEntry): Set<Read> {
  const declared = new Set<Read>();
  for (const v of entry.validators) {
    if (v.target === 'json' || v.target === 'query' || v.target === 'param') declared.add(v.target);
    if (v.target === 'form') declared.add('form');
  }
  if (entry.operations[0]?.body) {
    declared.add('raw');
    declared.add('form');
  }
  return declared;
}

type Thrown = { status: number; code: string };

/** The text of each balanced `(...)` that opens at `from`, skipping what a string literal or a comment holds. */
function balanced(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) return text.slice(from);
      i = end;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return text.slice(from);
      i = end + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return text.slice(from, i + 1);
  }
  return text.slice(from);
}

/** Each `new HTTPException(status, { ..., cause: { code } })` a handler's own text writes, and the 404 of the project lookup it calls. */
export function thrownInline(handlerSource: string): Thrown[] {
  const out: Thrown[] = [];
  // `new HTTPException(` as written, or as a bundler's import wrapper writes it: `new ns.HTTPException(`.
  for (const m of handlerSource.matchAll(/new (?:[\w$]+\.)?HTTPException\(/g)) {
    const call = balanced(handlerSource, (m.index ?? 0) + m[0].length - 1);
    const status = /^\(\s*(\d{3})/.exec(call)?.[1];
    if (!status) continue;
    const code = /cause:\s*\{\s*code:\s*['"`]([^'"`]+)['"`]/.exec(call)?.[1];
    out.push({ status: Number(status), code: code ?? statusToCode(Number(status)) });
  }
  // The project the request names is looked up by a helper that throws 404 where there is none or
  // the caller cannot see it. A call whose refusal is caught on the spot answers nothing of the kind.
  for (const m of handlerSource.matchAll(/\bloadProjectAccess\)?\(/g)) {
    const from = (m.index ?? 0) + m[0].length - 1;
    const after = handlerSource.slice(from + balanced(handlerSource, from).length);
    if (!/^\s*\.catch\(/.test(after)) {
      out.push({ status: 404, code: 'NOT_FOUND' });
      break;
    }
  }
  return out;
}

function walkRefs(node: unknown, visit: (ref: string) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walkRefs(child, visit);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, child] of Object.entries(node)) {
    if (key === '$ref' && typeof child === 'string') visit(child);
    else walkRefs(child, visit);
  }
}

export function checkReference({ reference, written }: CheckInput): Finding[] {
  const findings: Finding[] = [...reference.findings];
  const { document, routes } = reference;

  const seen = new Map<string, string>();
  for (const entry of routes) {
    // OpenAPI reads `/x/{a}` and `/x/{b}` as one path, whatever the parameters are called.
    const where = `${entry.method.toLowerCase()} ${openApiPath(entry.path).replace(/\{[^}]+\}/g, '{}')}`;
    const held = seen.get(where);
    if (held && held !== entry.key) {
      findings.push({
        rule: 'path-collision',
        route: entry.key,
        detail: `${held} is the same OpenAPI path and method; one would overwrite the other`,
      });
    }
    seen.set(where, entry.key);
    if (!document.paths[openApiPath(entry.path)]?.[entry.method.toLowerCase()]) {
      findings.push({
        rule: 'omitted',
        route: entry.key,
        detail: 'the route is served but is not an operation of the document',
      });
    }

    const text = Function.prototype.toString.call(entry.handler);
    const declared = declaredInputs(entry);
    for (const read of inputsRead(text)) {
      if (declared.has(read)) continue;
      findings.push({
        rule: 'undeclared-input',
        route: entry.key,
        detail: `the handler reads the request's ${read} and no schema is declared for it: validate it with zValidator('${read}', ...) or declare the schema it parses with`,
      });
    }

    const answered = reference.errors.get(entry.key);
    for (const { status, code } of thrownInline(text)) {
      if (!answered?.get(status)?.has(code)) {
        findings.push({
          rule: 'undeclared-error',
          route: entry.key,
          detail: `the handler throws ${status} ${code} and describeOperation does not declare it`,
        });
      }
    }
  }

  const named = new Set<string>();
  for (const byStatus of reference.errors.values()) {
    for (const codes of byStatus.values()) for (const code of codes) named.add(code);
  }
  for (const code of [...named].sort()) {
    if (!written.has(code)) {
      findings.push({
        rule: 'typo-code',
        route: 'document',
        detail: `error code ${code} is declared and is written in no source file`,
      });
    }
  }

  const schemas = document.components.schemas;
  const reported = new Set<string>();
  walkRefs(document, (ref) => {
    const name = ref.startsWith('#/components/schemas/')
      ? ref.slice('#/components/schemas/'.length)
      : null;
    if ((name === null || !(name in schemas)) && !reported.has(ref)) {
      reported.add(ref);
      findings.push({ rule: 'dangling-ref', route: 'document', detail: `${ref} names no schema` });
    }
  });

  return findings;
}

/** The finding as one line a failing test prints: rule, route, detail. */
export function describeFinding(finding: Finding): string {
  return `[${finding.rule}] ${finding.route}: ${finding.detail}`;
}
