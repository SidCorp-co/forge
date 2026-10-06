import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type RequestPart = 'json' | 'query' | 'param' | 'form' | 'header' | 'cookie';

export type RequestRead =
  | { kind: 'validated'; part: RequestPart; via: string }
  | { kind: 'body'; via: string }
  | { kind: 'query'; via: string };

const VALIDATED = /\.req\.valid\(\s*["'`](json|query|param|form|header|cookie)["'`]\s*\)/g;
const BODY = /\.req\.(json|parseBody|text|formData|arrayBuffer|blob)\s*(?:<[^()]*>)?\s*\(/g;
const RAW = /\.req\.raw\b(?!\s*\.\s*(?:headers|method|url|signal)\b)/g;
const QUERY = /\.req\.(query|queries)\s*(?:<[^()]*>)?\s*\(/g;
const SEARCH_PARAMS = /\bsearchParams\b/;
const REQUEST_URL = /\.req\.url\b/;

function viaAll(re: RegExp, source: string, show: (m: RegExpMatchArray) => string): string[] {
  return [...new Set([...source.matchAll(re)].map(show))].sort();
}

// a handler's own text is what it reads; a read this cannot see sits in a helper, and the
// source scan below refuses those, so the two together leave no read undescribed
export function readsOf(source: string): RequestRead[] {
  const reads: RequestRead[] = [];
  for (const m of source.matchAll(VALIDATED)) {
    const part = m[1] as RequestPart;
    if (!reads.some((r) => r.kind === 'validated' && r.part === part)) {
      reads.push({ kind: 'validated', part, via: `c.req.valid('${part}')` });
    }
  }
  for (const via of viaAll(BODY, source, (m) => `c.req.${m[1]}()`))
    reads.push({ kind: 'body', via });
  if (RAW.test(source)) reads.push({ kind: 'body', via: 'c.req.raw' });
  RAW.lastIndex = 0;
  for (const via of viaAll(QUERY, source, (m) => `c.req.${m[1]}()`)) {
    reads.push({ kind: 'query', via });
  }
  if (SEARCH_PARAMS.test(source) && REQUEST_URL.test(source)) {
    reads.push({ kind: 'query', via: 'new URL(c.req.url).searchParams' });
  }
  return reads;
}

const SOURCE_READ = /\.req\.(json|query|queries)\s*(?:<[^()]*>)?\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Every place in `root` that reads a JSON body or a query outside a validator, where no route can
 * be held to it. A body no zod schema holds (multipart, bytes, a signed payload) is read raw, and
 * the route-level check holds the route reading it to a rawBody() declaration instead.
 */
export function undeclaredSourceReads(root: string, base: string): string[] {
  const refusals: string[] = [];
  for (const file of sourceFiles(root).sort()) {
    for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
      const m = line.match(SOURCE_READ);
      if (m === null) continue;
      refusals.push(
        `${relative(base, file)}:${i + 1}: reads the request with \`${m[0].trim()}\` outside a validator — declare the part with zValidator() and read it with c.req.valid()`,
      );
    }
  }
  return refusals;
}
