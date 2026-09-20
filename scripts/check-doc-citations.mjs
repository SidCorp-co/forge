#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');
const MANIFESTS = ['package.json', 'Cargo.toml'];
const MARKER = /doc-citation:\s*unchecked\s*[—-]\s*\S/;
const MARKER_REACH = 3;
const DEFAULTS = {
  skipDocs: [],
  pathExts: [
    'ts',
    'tsx',
    'mjs',
    'cjs',
    'js',
    'jsx',
    'json',
    'md',
    'rs',
    'sql',
    'toml',
    'yaml',
    'yml',
    'sh',
    'css',
    'txt',
  ],
  sourceExts: ['ts', 'tsx', 'mjs', 'cjs', 'js', 'jsx', 'rs', 'sql'],
  skipPrefixes: ['dist/', 'node_modules/', '.next/', 'coverage/', 'target/', '.turbo/'],
};

function die(message) {
  console.error(`check-doc-citations: ${message}`);
  process.exit(2);
}

function config() {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    const declared = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))?.checkers?.['doc-citations'];
    return { ...DEFAULTS, ...(declared ?? {}) };
  } catch (err) {
    die(`${CONFIG_PATH} is not readable JSON: ${err.message}`);
  }
}

/** `**` crosses directories, `*` does not — the two are split apart before either is escaped. */
const globRe = (glob) =>
  new RegExp(
    `^${glob
      .split('**')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
      .join('.*')}$`,
  );

/**
 * The document's home: the nearest ancestor holding a package manifest, or the
 * repository root where there is none. A citation is resolved inside its home and
 * nowhere else, so deleting the file a document cites cannot be concealed by a
 * namesake in another package — and cannot be concealed by the cited directory
 * disappearing either, because the boundary is the manifest rather than the thing
 * being looked for.
 */
export function homeOf(rel, manifestDirs) {
  let dir = posix.dirname(rel);
  while (dir !== '.' && dir !== '/') {
    if (manifestDirs.has(dir)) return dir;
    dir = posix.dirname(dir);
  }
  return '';
}

const strip = (text) =>
  text
    .replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^ {4,}\S[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '));

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Every inline-code span in one document that reads as a claim about a file.
 * A token needs either a directory separator or a source-file extension: a bare
 * `README.md` names no one file and a bare word names nothing at all.
 */
export function citationsIn(rel, source, cfg = DEFAULTS) {
  const pathExt = new RegExp(`\\.(${cfg.pathExts.join('|')})$`);
  const sourceExt = new RegExp(`\\.(${cfg.sourceExts.join('|')})$`);
  const excused = new Set();
  source.split('\n').forEach((line, i) => {
    if (MARKER.test(line)) for (let l = i + 1; l <= i + 1 + MARKER_REACH; l++) excused.add(l);
  });
  const text = strip(source);
  const out = [];
  for (const hit of text.matchAll(/`([^`\n]+)`/g)) {
    const token = hit[1].trim();
    if (/\s/.test(token)) continue;
    if (/:\/\//.test(token) || token.startsWith('http') || token.startsWith('/')) continue;
    if (/[*<>{}$\\]/.test(token) || token.includes('...') || token.startsWith('@')) continue;
    const numbered = token.match(/^(.+?):(\d+)$/);
    const anchored = token.match(/^(.+?):([A-Za-z_$][\w$.]*)$/);
    const target = numbered?.[1] ?? anchored?.[1] ?? token;
    if (!pathExt.test(target) && !target.endsWith('/')) continue;
    if (!target.includes('/') && !sourceExt.test(target)) continue;
    // A bare extension — `.ts`, `.sql` — names the KIND of a file and no file at all.
    if (/^\.[A-Za-z0-9]+$/.test(target.split('/').pop())) continue;
    if (cfg.skipPrefixes.some((p) => target.startsWith(p))) continue;
    out.push({
      rel,
      line: lineOf(text, hit.index),
      token,
      target,
      symbol: numbered ? null : (anchored?.[2] ?? null),
      numbered: Boolean(numbered),
      excused: excused.has(lineOf(text, hit.index)),
    });
  }
  return out.filter((c) => !c.excused);
}

/**
 * Where a citation points. A path already written from a known origin — relative to
 * the document, or from the repository root — names one file and is resolved there;
 * scoping could only narrow an answer that is already exact. Shorthand is the case
 * scoping exists for, and it is matched by path suffix inside the document's HOME
 * and nowhere else, so a namesake in another package can never stand in for the file
 * a document meant. More than one match is ambiguous rather than resolved.
 */
export function resolveCitation(citation, home, world) {
  const isDir = citation.target.endsWith('/');
  const bare = isDir ? citation.target.replace(/\/+$/, '') : citation.target;
  const pool = isDir ? world.dirs : world.files;
  if (/^\.{1,2}\//.test(bare)) {
    const exact = posix.normalize(posix.join(posix.dirname(citation.rel), bare));
    return pool.includes(exact) ? [exact] : [];
  }
  if (pool.includes(bare)) return [bare];
  const under = home === '' ? pool : pool.filter((p) => p.startsWith(`${home}/`));
  return under.filter((p) => p.endsWith(`/${bare}`));
}

/**
 * The three findings that fail and the two that only report, over one scan.
 * Nothing is dropped in silence: a path git keeps out of the tree by design and a
 * citation matching more than one file are each printed, because an exclusion
 * nobody sees is indistinguishable from a rule nobody wrote.
 */
export function judge(citations, world) {
  const dead = [];
  const numbered = [];
  const badAnchor = [];
  const ambiguous = [];
  const unverifiable = [];
  const drift = [];
  for (const c of citations) {
    if (c.numbered) {
      numbered.push(c);
      continue;
    }
    const home = homeOf(c.rel, world.manifestDirs);
    const hits = resolveCitation(c, home, world);
    if (hits.length === 0) {
      (world.ignored(c.target) ? unverifiable : dead).push({ ...c, home });
      continue;
    }
    if (hits.length > 1) {
      ambiguous.push({ ...c, hits });
      continue;
    }
    if (c.symbol !== null && !world.contains(hits[0], c.symbol.split('.').pop())) {
      badAnchor.push({ ...c, at: hits[0] });
      continue;
    }
    // A DIRECTORY citation claims the directory is there, and a directory changes
    // whenever anything inside it does — so dating one against the document would put
    // 26 of this repo's 81 worklist entries on a claim that never went stale.
    if (world.shallow === true || c.target.endsWith('/')) continue;
    const moved = world.changedAt(hits[0]);
    const wrote = world.changedAt(c.rel);
    if (moved > wrote && moved > 0 && wrote > 0) drift.push({ ...c, at: hits[0] });
  }
  return { dead, numbered, badAnchor, ambiguous, unverifiable, drift };
}

const at = (c) => `${c.rel}:${c.line}`;

function world(cfg) {
  const files = execFileSync('git', ['ls-files'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  if (files.length === 0)
    die('`git ls-files` listed nothing, so every citation below would read dead');
  const dirs = new Set();
  const manifestDirs = new Set();
  for (const p of files) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (MANIFESTS.includes(parts.at(-1))) manifestDirs.add(parts.slice(0, -1).join('/'));
  }
  const body = new Map();
  const when = new Map();
  const shallow =
    execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim() === 'true';
  return {
    files,
    shallow,
    dirs: [...dirs],
    manifestDirs,
    ignored: (p) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--', p], { cwd: ROOT, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    contains: (p, symbol) => {
      if (!body.has(p))
        body.set(p, existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');
      return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body.get(p));
    },
    changedAt: (p) => {
      if (!when.has(p)) {
        const out = execFileSync('git', ['log', '-1', '--format=%ct', '--', p], {
          cwd: ROOT,
          encoding: 'utf8',
        }).trim();
        when.set(p, Number(out) || 0);
      }
      return when.get(p);
    },
    cfg,
  };
}

function reportSilences({ ambiguous, unverifiable }) {
  if (unverifiable.length > 0) {
    console.log(
      `check-doc-citations: ${unverifiable.length} citation(s) name a path git keeps out of the tree,\n` +
        'so nothing here can say whether they are true. Printed rather than dropped:',
    );
    for (const c of unverifiable) console.log(`  ${at(c)} — ${c.token}`);
  }
  if (ambiguous.length > 0) {
    console.log(
      `check-doc-citations: ${ambiguous.length} citation(s) match more than one file inside their own\n` +
        'package, so which one is meant is a guess and none of them was measured:',
    );
    for (const c of ambiguous) console.log(`  ${at(c)} — ${c.token} matches ${c.hits.length}`);
  }
}

function reportDrift(drift, listAll, shallow) {
  if (shallow) {
    console.log(
      '\ncheck-doc-citations: this checkout is shallow, so every file dates from the same\n' +
        'commit and no document can be older than what it cites. The worklist was NOT measured —\n' +
        'said here rather than reported as zero, which reads exactly like a clean tree.',
    );
    return;
  }
  if (drift.length === 0) return;
  const byDoc = new Map();
  for (const c of drift) byDoc.set(c.rel, (byDoc.get(c.rel) ?? 0) + 1);
  console.log(
    `\ncheck-doc-citations: ${drift.length} citation(s) across ${byDoc.size} document(s) name a file\n` +
      'that was changed after the document was. Each is a worklist entry — still true, edited or\n' +
      'deleted — and not a build failure, because a live citation may simply still be right:',
  );
  if (listAll) for (const c of drift) console.log(`  ${at(c)} — ${c.token} -> ${c.at}`);
  else
    for (const [doc, n] of [...byDoc].sort((a, b) => b[1] - a[1])) console.log(`  ${doc} — ${n}`);
  if (!listAll) console.log('  (--drift lists each one)');
}

function reportFaults({ dead, numbered, badAnchor }) {
  console.error(
    `check-doc-citations: ${dead.length} citation(s) name a file that is not there, ` +
      `${numbered.length} cite a line number, ${badAnchor.length} name a symbol its file does not hold:\n`,
  );
  for (const c of dead) {
    console.error(`  ${at(c)} — ${c.token} is not in ${c.home === '' ? 'the tree' : c.home}`);
  }
  for (const c of numbered) console.error(`  ${at(c)} — ${c.token} cites a line number`);
  for (const c of badAnchor)
    console.error(`  ${at(c)} — ${c.token} — ${c.at} does not hold ${c.symbol}`);
  console.error(
    '\nA document that names a file makes a claim a machine can check, and a claim nothing checks\n' +
      'goes false in silence: 93 documents in this repo had to be deleted rather than corrected\n' +
      'before anything measured this. Correct the citation, or delete the sentence that carries it.\n' +
      'A line number is stale the moment anything above it moves, which is why CLAUDE.md forbids\n' +
      'one and this refuses it: cite the identifier or the file.ts:symbol anchor instead.\n\n' +
      'A token that is not a claim about this repository — a path inside a dependency, a filename\n' +
      'template, a stack frame quoted from a log — says so where it is written, in a comment within\n' +
      `${MARKER_REACH} lines above it, reading: <!-- doc-citation: unchecked — <why it is not a ` +
      'claim about this tree> -->',
  );
}

function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--all')) {
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  }
  const cfg = config();
  const w = world(cfg);
  const skip = (cfg.skipDocs ?? []).map((d) => globRe(typeof d === 'string' ? d : d.glob));
  const docs = w.files
    .filter((p) => p.endsWith('.md'))
    .filter((p) => !skip.some((re) => re.test(p)));
  if (docs.length === 0) die('no documents left to scan — every tracked .md is excluded');

  const citations = docs.flatMap((rel) =>
    citationsIn(rel, readFileSync(join(ROOT, rel), 'utf8'), cfg),
  );
  const verdict = judge(citations, w);

  reportSilences(verdict);
  reportDrift(verdict.drift, args.includes('--drift'), w.shallow);

  const faults = verdict.dead.length + verdict.numbered.length + verdict.badAnchor.length;
  if (faults > 0) {
    reportFaults(verdict);
    process.exit(1);
  }

  const checked = citations.length - verdict.ambiguous.length - verdict.unverifiable.length;
  console.log(
    `\ndoc-citations: ${docs.length} document(s) scanned, ${citations.length} citation(s), ` +
      `${checked} checked, ${verdict.drift.length} on the worklist`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
