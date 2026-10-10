#!/usr/bin/env node

// web-v2's product copy lives in copy files owned where each feature lives
// (`src/lib/i18n/copy/<feature>.json`) and, for shared chrome, `src/lib/i18n/copy/<area>.json`,
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
  agents: 'lib/i18n/copy/agents.json',
  attachments: 'lib/i18n/copy/attachments.json',
  attention: 'lib/i18n/copy/attention.json',
  auth: 'lib/i18n/copy/auth.json',
  automation: 'lib/i18n/copy/automation.json',
  chat: 'lib/i18n/copy/chat.json',
  checklist: 'lib/i18n/copy/checklists.json',
  common: 'lib/i18n/copy/common.json',
  contracts: 'lib/i18n/copy/contracts.json',
  conversations: 'lib/i18n/copy/conversations.json',
  dash: 'lib/i18n/copy/project-dashboard.json',
  decisions: 'lib/i18n/copy/comments.json',
  designs: 'lib/i18n/copy/workflows.json',
  ecosystem: 'lib/i18n/copy/ecosystem.json',
  eta: 'lib/i18n/copy/forecast.json',
  fc: 'lib/i18n/copy/forecast.json',
  feedback: 'lib/i18n/copy/feedback.json',
  forecast: 'lib/i18n/copy/forecast.json',
  help: 'lib/i18n/copy/tours.json',
  intake: 'lib/i18n/copy/intake.json',
  integrations: 'lib/i18n/copy/integrations.json',
  issues: 'lib/i18n/copy/issues.json',
  label: 'lib/i18n/copy/label.json',
  language: 'lib/i18n/copy/settings.json',
  list: 'lib/i18n/copy/list.json',
  masters: 'lib/i18n/copy/agents.json',
  memory: 'lib/i18n/copy/memory.json',
  modules: 'lib/i18n/copy/modules.json',
  nav: 'lib/i18n/copy/shell.json',
  needs: 'lib/i18n/copy/needs-you.json',
  needsYou: 'lib/i18n/copy/needs-you.json',
  onboarding: 'lib/i18n/copy/onboarding.json',
  operator: 'lib/i18n/copy/operator.json',
  overview: 'lib/i18n/copy/overview.json',
  pairing: 'lib/i18n/copy/pairing.json',
  pipeline: 'lib/i18n/copy/pipeline.json',
  previews: 'lib/i18n/copy/previews.json',
  progress: 'lib/i18n/copy/forecast.json',
  projects: 'lib/i18n/copy/projects.json',
  pulse: 'lib/i18n/copy/overview.json',
  questions: 'lib/i18n/copy/questions.json',
  releases: 'lib/i18n/copy/releases.json',
  requirements: 'lib/i18n/copy/requirements.json',
  roadmap: 'lib/i18n/copy/project-status.json',
  runners: 'lib/i18n/copy/runners.json',
  runs: 'lib/i18n/copy/agents.json',
  schedules: 'lib/i18n/copy/automation.json',
  session: 'lib/i18n/copy/session.json',
  sessions: 'lib/i18n/copy/sessions.json',
  settings: 'lib/i18n/copy/settings.json',
  'settings.agents': 'lib/i18n/copy/agent-accounts.json',
  'settings.orgs': 'lib/i18n/copy/orgs.json',
  'settings.project': 'lib/i18n/copy/project-settings.json',
  shares: 'lib/i18n/copy/shares.json',
  shell: 'lib/i18n/copy/shell.json',
  standing: 'lib/i18n/copy/standing.json',
  status: 'lib/i18n/copy/project-status.json',
  time: 'lib/i18n/copy/time.json',
  tour: 'lib/i18n/copy/tours.json',
  tours: 'lib/i18n/copy/tours.json',
  visual: 'lib/i18n/copy/visual-blocks.json',
  whatsNew: 'lib/i18n/copy/whats-new.json',
  workflows: 'lib/i18n/copy/workflows.json',
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
