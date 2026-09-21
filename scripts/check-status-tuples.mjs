#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.forge', 'conformance.json');
const VOCABULARIES = {
  issue: { file: 'packages/core/src/db/schema.ts', symbol: 'issueStatuses' },
  job: { file: 'packages/core/src/db/schema.ts', symbol: 'jobStatuses' },
  session: { file: 'packages/core/src/db/session-vocabulary.ts', symbol: 'agentSessionStatuses' },
};
const DISCRIMINATOR = {
  issue: /\bissues?\b|IssueStatus/,
  job: /\bjobs?\b|JobStatus/,
  session: /agentSessions?|AgentSession/i,
};
// A status literal in either quote style: `packages/core` and `packages/contracts`
// are formatted with single quotes and `packages/web-v2` with double, so a
// single-quote-only scan reads the browser package as holding no tuples at all.
const QUOTED = /['"]([a-z_]+)['"]/g;
const TUPLE = /\[\s*((?:['"][a-z_]+['"]\s*,\s*)+['"][a-z_]+['"]\s*),?\s*\]/g;
const DIFFERS = /status-tuple:\s*differs\s*[—-]\s*\S/;
const MARKER_REACH = 6;
const DEFAULTS = {
  scanRoots: ['packages/core/src', 'packages/contracts/src'],
  scanExts: ['.ts', '.tsx'],
  skipDirs: ['node_modules', 'dist', 'coverage', '.next', '.turbo', 'drizzle'],
};

function die(message) {
  console.error(`check-status-tuples: ${message}`);
  process.exit(2);
}

function config() {
  if (!existsSync(CONFIG_PATH)) return DEFAULTS;
  try {
    const declared = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))?.checkers?.['status-tuples'];
    return { ...DEFAULTS, ...(declared ?? {}) };
  } catch (err) {
    die(`${CONFIG_PATH} is not readable JSON: ${err.message}`);
  }
}

function readVocabularies() {
  const read = {};
  const sources = new Map();
  for (const [name, { file, symbol }] of Object.entries(VOCABULARIES)) {
    if (!sources.has(file)) {
      const abs = join(ROOT, file);
      if (!existsSync(abs)) {
        die(
          `${file} is not there, so the status vocabularies cannot be read and every\n` +
            'tuple below would be measured against an empty list',
        );
      }
      sources.set(file, readFileSync(abs, 'utf8'));
    }
    const hit = sources
      .get(file)
      .match(new RegExp(`export const ${symbol}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
    if (!hit) {
      die(
        `${file} no longer declares \`export const ${symbol} = [...] as const\`.\n` +
          'The checker reads its vocabularies from that declaration rather than carrying a copy,\n' +
          'so a rename there stops the scan instead of quietly narrowing it. Point this checker at\n' +
          'the new name.',
      );
    }
    const members = new Set([...hit[1].matchAll(QUOTED)].map((m) => m[1]));
    if (members.size === 0) die(`${symbol} parsed to an empty vocabulary`);
    read[name] = members;
  }
  return read;
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function markedLines(source) {
  const marked = new Set();
  source.split('\n').forEach((line, i) => {
    if (DIFFERS.test(line)) marked.add(i + 1);
  });
  return marked;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function walk(rel, cfg, acc) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!cfg.skipDirs.includes(entry.name)) walk(path, cfg, acc);
      continue;
    }
    if (!cfg.scanExts.some((ext) => entry.name.endsWith(ext))) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    acc.push(path);
  }
  return acc;
}

/** The vocabulary a tuple is drawn from, or null where the text does not say. */
export function attributeVocabulary(members, context, vocabularies) {
  const candidates = Object.entries(vocabularies)
    .filter(([, members_]) => members.every((m) => members_.has(m)))
    .map(([name]) => name);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const named = candidates.filter((name) => DISCRIMINATOR[name].test(context));
  return named.length === 1 ? named[0] : null;
}

export function sitesIn(rel, source, vocabularies, unattributed = []) {
  const marked = markedLines(source);
  const text = stripComments(source);
  const sites = [];
  for (const hit of text.matchAll(TUPLE)) {
    const members = [...hit[1].matchAll(QUOTED)].map((m) => m[1]);
    const before = text.slice(0, hit.index);
    // A tuple written as an object-literal property value is a table row, not a
    // named question: `transitions` and `JOB_TYPE_EXPECTED_EXIT_STATUS` both hold
    // rows that coincide with a constant without restating it.
    if (/:\s*$/.test(before)) continue;
    const context = text.slice(Math.max(0, hit.index - 260), hit.index + 260);
    const vocabulary = attributeVocabulary(members, context, vocabularies);
    const line = lineOf(text, hit.index);
    if (vocabulary === null) {
      if (Object.values(vocabularies).some((v) => members.every((m) => v.has(m)))) {
        unattributed.push({ rel, line, members });
      }
      continue;
    }
    const declaration = before
      .slice(-160)
      .match(
        /(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*(?::[^=]*?)?=\s*(?:new Set(?:<[^>]*>)?\(\s*)?$/,
      );
    let excused = false;
    for (let l = line; l >= line - MARKER_REACH; l--) if (marked.has(l)) excused = true;
    sites.push({
      rel,
      line,
      vocabulary,
      key: `${vocabulary}|${[...members].sort().join(',')}`,
      name: declaration ? declaration[1] : null,
      excused,
    });
  }
  return sites;
}

/**
 * The two rules, over the sites of one scan. A site carrying the differs marker
 * is excused from both: it has said at the declaration why this answer cannot be
 * the other.
 */
export function judge(sites) {
  const groups = new Map();
  for (const site of sites) {
    if (!groups.has(site.key)) groups.set(site.key, []);
    groups.get(site.key).push(site);
  }
  const twoAnswers = [];
  const restatements = [];
  for (const [key, members] of groups) {
    const declarations = members.filter((s) => s.name !== null);
    const unexcused = declarations.filter((s) => !s.excused);
    if (unexcused.length > 1) twoAnswers.push({ key, declarations: unexcused });
    if (declarations.length === 0) continue;
    const owner = unexcused[0] ?? declarations[0];
    for (const inline of members.filter((s) => s.name === null && !s.excused)) {
      restatements.push({ key, inline, owner });
    }
  }
  return { groups, twoAnswers, restatements };
}

const at = (s) => `${s.rel}:${s.line}`;

function main() {
  const mode = process.argv[2];
  if (mode !== '--all') {
    die('the only mode is --all — a staged subset reports clean on a tree that is not');
  }

  const cfg = config();
  const vocabularies = readVocabularies();
  const files = cfg.scanRoots.reduce((acc, rel) => walk(rel, cfg, acc), []);
  if (files.length === 0) die(`no source files found under ${cfg.scanRoots.join(', ')}`);

  const unattributed = [];
  const sites = files.flatMap((rel) =>
    sitesIn(rel, readFileSync(join(ROOT, rel), 'utf8'), vocabularies, unattributed),
  );
  const { groups, twoAnswers, restatements } = judge(sites);

  if (unattributed.length > 0) {
    console.log(
      `check-status-tuples: ${unattributed.length} tuple(s) fit more than one status vocabulary\n` +
        'and nothing nearby says which, so they were not measured. Printed rather than dropped,\n' +
        'so the exclusion cannot go quiet:',
    );
    for (const u of unattributed) console.log(`  ${at(u)} — [${u.members.join(', ')}]`);
  }

  if (twoAnswers.length > 0 || restatements.length > 0) {
    console.error(
      `check-status-tuples: ${twoAnswers.length} status tuple(s) with more than one declaration, ` +
        `${restatements.length} inline restatement(s) of a tuple a constant already holds:\n`,
    );
    for (const fault of twoAnswers) {
      console.error(
        `  [${fault.key.split('|')[1]}] is declared ${fault.declarations.length} times:`,
      );
      for (const d of fault.declarations) console.error(`    ${d.name} — ${at(d)}`);
    }
    for (const fault of restatements) {
      console.error(
        `  ${at(fault.inline)} writes [${fault.key.split('|')[1]}] inline — ` +
          `${fault.owner.name} at ${at(fault.owner)} already holds it`,
      );
    }
    console.error(
      '\nOne question has one answer. Two constants holding the same status tuple are one answer\n' +
        'with two labels whatever they are called, and an inline copy is a third label with no\n' +
        'name at all: each is a place a later change can move one copy and leave the rest, which\n' +
        'is how the same predicate starts giving two verdicts. Keep the surviving name in the\n' +
        'module that owns the concept and move every caller to it.\n\n' +
        'A pair that genuinely must differ says so at the declaration, in a comment within\n' +
        `${MARKER_REACH} lines above it, reading: status-tuple: differs — <why this answer ` +
        'cannot be the other>',
    );
    process.exit(1);
  }

  console.log(
    `status-tuples: ${files.length} file(s) scanned, ${sites.length} tuple(s), ` +
      `${groups.size} distinct answer(s)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
