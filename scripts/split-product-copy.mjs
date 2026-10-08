#!/usr/bin/env node

// web-v2's product copy lives in copy files owned where each feature lives
// (`src/features/<domain>/copy.json`) and, for shared chrome, `src/lib/i18n/copy/<area>.json`,
// listed by `src/lib/i18n/copy-files.ts` and read through `product-copy.ts`. It was one file,
// `src/lib/i18n/product-copy.json`, which every web lane edited, so nearly every merge of two lanes conflicted on it. This script made
// the split, and stays because a lane cut before the split still edits the old file: it carries that
// lane's edits into the copy files mechanically, so nobody re-types keys by hand.
//
//   node scripts/split-product-copy.mjs                  split the old file, or carry its edits when
//                                                        the copy files already exist (during a merge
//                                                        the edits are read from the merge base)
//   node scripts/split-product-copy.mjs --base <rev>     carry, reading the old file the edits started
//                                                        from at <rev> (after a rebase, or a merge
//                                                        already committed)
//   node scripts/split-product-copy.mjs --check          refuse the old file standing in the tree,
//                                                        naming each of its edited keys' home
//   --old <path>                                         read the old file from <path> instead

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = join(ROOT, 'packages/web-v2/src');
const OLD_REL = 'packages/web-v2/src/lib/i18n/product-copy.json';

/**
 * Where a key lives, by its own prefix (the longest that matches wins). Measured at the split: the
 * first segment names the feature that reads the key, bar `settings`, whose second segment does.
 * A prefix the table lacks is refused by name, never guessed.
 */
export const PREFIX_HOMES = {
  agents: 'features/agents/copy.json',
  automation: 'features/automation/copy.json',
  common: 'lib/i18n/copy/common.json',
  contracts: 'features/contracts/copy.json',
  conversations: 'features/conversations/copy.json',
  dash: 'features/project-dashboard/copy.json',
  decisions: 'features/comments/copy.json',
  designs: 'features/workflows/copy.json',
  ecosystem: 'features/ecosystem/copy.json',
  eta: 'features/forecast/copy.json',
  fc: 'features/forecast/copy.json',
  feedback: 'features/feedback/copy.json',
  forecast: 'features/forecast/copy.json',
  help: 'features/tours/copy.json',
  integrations: 'features/integrations/copy.json',
  issues: 'features/issues/copy.json',
  label: 'lib/i18n/copy/label.json',
  language: 'features/settings/copy.json',
  list: 'lib/i18n/copy/list.json',
  masters: 'features/agents/copy.json',
  memory: 'features/memory/copy.json',
  modules: 'features/modules/copy.json',
  nav: 'features/shell/copy.json',
  needs: 'features/needs-you/copy.json',
  needsYou: 'features/needs-you/copy.json',
  onboarding: 'features/onboarding/copy.json',
  overview: 'features/overview/copy.json',
  pipeline: 'features/pipeline/copy.json',
  progress: 'features/forecast/copy.json',
  pulse: 'features/overview/copy.json',
  questions: 'features/questions/copy.json',
  releases: 'features/releases/copy.json',
  requirements: 'features/requirements/copy.json',
  roadmap: 'features/project-status/copy.json',
  runners: 'features/runners/copy.json',
  runs: 'features/agents/copy.json',
  schedules: 'features/automation/copy.json',
  sessions: 'features/sessions/copy.json',
  settings: 'features/settings/copy.json',
  'settings.agents': 'features/agent-accounts/copy.json',
  'settings.orgs': 'features/orgs/copy.json',
  'settings.project': 'features/project-settings/copy.json',
  shell: 'features/shell/copy.json',
  standing: 'lib/i18n/copy/standing.json',
  status: 'features/project-status/copy.json',
  time: 'lib/i18n/copy/time.json',
  tour: 'features/tours/copy.json',
  tours: 'features/tours/copy.json',
  whatsNew: 'features/whats-new/copy.json',
  workflows: 'features/workflows/copy.json',
  written: 'lib/i18n/copy/written.json',
};

export function prefixHome(key) {
  let best = null;
  for (const prefix of Object.keys(PREFIX_HOMES)) {
    if ((key === prefix || key.startsWith(`${prefix}.`)) && (!best || prefix.length > best.length))
      best = prefix;
  }
  return best ? PREFIX_HOMES[best] : null;
}

/** Every copy file on disk, as `{ path relative to web-v2/src: { language: { key: text } } }`. */
export function readCopyFiles(src = SRC) {
  const paths = [];
  for (const dir of readdirSync(join(src, 'features'))) {
    if (existsSync(join(src, 'features', dir, 'copy.json')))
      paths.push(`features/${dir}/copy.json`);
  }
  if (existsSync(join(src, 'lib/i18n/copy'))) {
    for (const name of readdirSync(join(src, 'lib/i18n/copy'))) {
      if (name.endsWith('.json')) paths.push(`lib/i18n/copy/${name}`);
    }
  }
  return Object.fromEntries(
    paths.sort().map((p) => [p, JSON.parse(readFileSync(join(src, p), 'utf8'))]),
  );
}

/** language → key → the copy file holding it; a key two files hold is refused, naming both. */
export function holders(files) {
  const out = {};
  const twice = [];
  for (const [path, part] of Object.entries(files)) {
    for (const [lang, words] of Object.entries(part)) {
      out[lang] ??= {};
      for (const key of Object.keys(words)) {
        if (out[lang][key]) twice.push(`${lang} ${key}: ${out[lang][key]} and ${path}`);
        else out[lang][key] = path;
      }
    }
  }
  if (twice.length)
    fail(`a key lives in one copy file; these are in two:\n  ${twice.join('\n  ')}`);
  return out;
}

function fail(message) {
  console.error(`split-product-copy: ${message}`);
  process.exit(1);
}

function serialise(part) {
  const langs = Object.keys(part).sort((a, b) =>
    a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b),
  );
  const out = {};
  for (const lang of langs) {
    if (!Object.keys(part[lang]).length) continue;
    out[lang] = Object.fromEntries(
      Object.entries(part[lang]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function homeOf(key, lang, held) {
  return (
    held[lang]?.[key] ?? Object.values(held).find((byKey) => byKey[key])?.[key] ?? prefixHome(key)
  );
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function baseRev(named) {
  if (named) return named;
  try {
    return git('merge-base', 'HEAD', 'MERGE_HEAD');
  } catch {
    return fail(
      `the copy files already exist, so ${OLD_REL} holds a lane's edits to carry over, and no merge is in progress to read where they started. Name it: --base <rev>, the commit the edits started from (e.g. \`git merge-base HEAD origin/dev\` before the split landed).`,
    );
  }
}

function readBase(rev) {
  try {
    return JSON.parse(git('show', `${rev}:${OLD_REL}`));
  } catch {
    return fail(
      `${rev} holds no ${OLD_REL}: --base names the commit the old file's edits started from, before the split.`,
    );
  }
}

/** The (language, key) pairs `lane` changed from `base`: added or changed text, or a removal (null). */
function edits(base, lane) {
  const out = [];
  for (const lang of new Set([...Object.keys(base), ...Object.keys(lane)])) {
    const b = base[lang] ?? {};
    const l = lane[lang] ?? {};
    for (const key of new Set([...Object.keys(b), ...Object.keys(l)])) {
      if (b[key] !== l[key]) out.push({ lang, key, before: b[key], after: l[key] ?? null });
    }
  }
  return out;
}

function split(old) {
  const files = {};
  const homeless = [];
  for (const [lang, words] of Object.entries(old)) {
    for (const [key, text] of Object.entries(words)) {
      const home = prefixHome(key);
      if (!home) homeless.push(`${lang} ${key}`);
      else {
        files[home] ??= {};
        files[home][lang] ??= {};
        files[home][lang][key] = text;
      }
    }
  }
  if (homeless.length)
    fail(`no home names these keys' prefix; add it to PREFIX_HOMES:\n  ${homeless.join('\n  ')}`);
  for (const [path, part] of Object.entries(files)) {
    mkdirSync(dirname(join(SRC, path)), { recursive: true });
    writeFileSync(join(SRC, path), serialise(part));
  }
  return Object.keys(files);
}

function carry(old, base, files) {
  const held = holders(files);
  const conflicts = [];
  const homeless = [];
  const touched = new Set();
  const counts = { added: 0, changed: 0, removed: 0 };
  for (const { lang, key, before, after } of edits(base, old)) {
    const home = homeOf(key, lang, held);
    if (!home) {
      homeless.push(`${lang} ${key}`);
      continue;
    }
    const now = files[home]?.[lang]?.[key];
    if (now === after || (now === undefined && after === null)) continue;
    if (now !== before) {
      conflicts.push(
        `${lang} ${key} (${home}): the copy file reads ${JSON.stringify(now ?? null)}, the edit turns ${JSON.stringify(before ?? null)} into ${JSON.stringify(after)}`,
      );
      continue;
    }
    files[home] ??= {};
    files[home][lang] ??= {};
    if (after === null) {
      delete files[home][lang][key];
      counts.removed++;
    } else {
      counts[before === undefined ? 'added' : 'changed']++;
      files[home][lang][key] = after;
    }
    touched.add(home);
  }
  if (homeless.length)
    fail(
      `no copy file holds these keys and no home names their prefix; add it to PREFIX_HOMES:\n  ${homeless.join('\n  ')}`,
    );
  if (conflicts.length) {
    fail(
      `these keys were edited on both sides since the old file's base; settle each in the old file to the text it should read, then run this again (nothing was written):\n  ${conflicts.join('\n  ')}`,
    );
  }
  for (const path of touched) {
    mkdirSync(dirname(join(SRC, path)), { recursive: true });
    writeFileSync(join(SRC, path), serialise(files[path]));
  }
  return { counts, touched: [...touched].sort() };
}

function check(old, oldRel, files) {
  const held = holders(files);
  const lines = [];
  let living = 0;
  for (const [lang, words] of Object.entries(old)) {
    for (const [key, text] of Object.entries(words)) {
      const home = homeOf(key, lang, held);
      const now = home ? files[home]?.[lang]?.[key] : undefined;
      if (now === text) living++;
      else
        lines.push(
          `${lang} ${key} → ${home ? `src/${home}` : 'no home: add its prefix to PREFIX_HOMES'}${now === undefined ? ' (new)' : ' (changed)'}`,
        );
    }
  }
  fail(
    `${oldRel} is retired: the product copy lives in the copy files each feature owns, listed by src/lib/i18n/copy-files.ts. Carry this file's edits there with \`node scripts/split-product-copy.mjs\` (it reads the merge base during a merge; otherwise name --base <rev>).\n  ${lines.join('\n  ')}${lines.length ? '\n  ' : ''}${living} more key(s) already read the same in their copy file.`,
  );
}

function main(argv) {
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const oldPath = at('--old') ? resolve(at('--old')) : join(ROOT, OLD_REL);
  const oldRel = relative(ROOT, oldPath);
  if (!existsSync(oldPath)) {
    console.log(`${oldRel} does not exist: nothing to split or carry.`);
    return;
  }
  const old = JSON.parse(readFileSync(oldPath, 'utf8'));
  const files = readCopyFiles();
  if (argv.includes('--check')) return check(old, oldRel, files);
  if (!Object.keys(files).length) {
    const written = split(old);
    unlinkSync(oldPath);
    console.log(`split ${oldRel} into ${written.length} copy files; the old file is removed.`);
    return;
  }
  const { counts, touched } = carry(old, readBase(baseRev(at('--base'))), files);
  unlinkSync(oldPath);
  console.log(
    `carried ${counts.added} added, ${counts.changed} changed and ${counts.removed} removed key(s) into ${touched.length} copy file(s); ${oldRel} is removed.\nStage both: git rm --cached --ignore-unmatch ${oldRel} && git add ${touched.map((p) => `packages/web-v2/src/${p}`).join(' ')}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
