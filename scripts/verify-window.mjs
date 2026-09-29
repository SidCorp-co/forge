#!/usr/bin/env node

/**
 * One verify window: a set of changes each already green at its own head, validated together
 * once and landed one merge commit each. The tool builds, attributes and plans; it pushes, opens
 * and merges nothing, because landing stays the dispatcher's act. How it composes with ci.yml and
 * what it does not do: `docs/modules/landing/verify-window.md`.
 * Exit 0 as asked · 1 a member refused or isolated, not fired, or not landable · 2 could not run.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { admitMembers } from './lib/verify-window/admit.mjs';
import { assemble, prepareWindow } from './lib/verify-window/assemble.mjs';
import { classifyReplay, ownerOfPath, replay } from './lib/verify-window/attribute.mjs';
import { checkReader, repoSlugOf } from './lib/verify-window/checks.mjs';
import { decideFire } from './lib/verify-window/fire.mjs';
import { gitIn } from './lib/verify-window/git.mjs';
import { planLanding, windowBranch } from './lib/verify-window/land.mjs';
import { readManifest, renderLedger } from './lib/verify-window/ledger.mjs';

const USAGE = `Usage: node scripts/verify-window.mjs <verb> --window <manifest.json> [flags]
  admit                       judge each member's admission and build nothing
  fire [--now <iso>]          whether the window fires, and on what
  assemble [--tree <dir>]     build the combination and write the ledger beside the manifest
  isolate --member <ISS> --because <refusal>   rebuild without that member, recording why
  attribute --path <p>...     which landed member last changed each path
  attribute --unit <cmd> [--repeat n]          replay one command on the base and each member alone
  land                        whether the validated window may land, and the one merge that lands it
  --checks <file>             read check states from a saved file instead of \`gh api\``;

function die(msg) {
  console.error(`verify-window: ${msg}`);
  process.exit(2);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    window: { type: 'string' },
    tree: { type: 'string' },
    checks: { type: 'string' },
    now: { type: 'string' },
    member: { type: 'string' },
    because: { type: 'string' },
    path: { type: 'string', multiple: true },
    unit: { type: 'string' },
    repeat: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});
const verb = positionals[0];
if (values.help || !verb) {
  console.log(USAGE);
  process.exit(verb || values.help ? 0 : 2);
}
if (!values.window) die(`--window <manifest.json> is required\n${USAGE}`);

const manifestPath = resolve(values.window);
let raw;
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  die(`${manifestPath} is not a readable manifest: ${err.message}`);
}
const read = readManifest(raw);
if (read.refusal) die(`${manifestPath}: ${read.refusal}`);
const manifest = read.manifest;
const repoDir = gitIn(process.cwd()).run(['rev-parse', '--show-toplevel'])?.trim();
if (!repoDir) die('run this inside the repository the window lands on');
const ledgerPath = `${manifestPath.replace(/\.json$/, '')}.ledger.json`;
const treeDir = resolve(
  values.tree ?? join(repoDir, '.claude', 'worktrees', `verify-window-${manifest.window}`),
);
const readCheck = checkReader({ repoSlug: repoSlugOf(gitIn(repoDir)), file: values.checks });

function loadLedger() {
  if (!existsSync(ledgerPath)) die(`${ledgerPath} does not exist: assemble the window first`);
  return JSON.parse(readFileSync(ledgerPath, 'utf8'));
}

function saveLedger(ledger) {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(ledgerPath.replace(/\.json$/, '.md'), renderLedger(ledger));
}

/** Remove a tree this tool built. Anything that is not a registered worktree of the repository is
 * refused rather than deleted, so a mistaken `--tree` never takes an unrelated directory with it. */
function removeTree(dir) {
  const g = gitIn(repoDir);
  if (!existsSync(dir)) {
    g.run(['worktree', 'prune']);
    return;
  }
  const registered = (g.run(['worktree', 'list', '--porcelain']) ?? '')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => existsSync(p))
    .map((p) => realpathSync(p));
  if (!registered.includes(realpathSync(dir))) {
    die(
      `${dir} is not a worktree of ${repoDir}, so it is not a tree this window built; nothing removed`,
    );
  }
  g.must(['worktree', 'remove', '--force', dir]);
}

function build(dir, m = manifest, replay = undefined) {
  const r = assemble({ repoDir, manifest: m, treeDir: dir, readCheck, replay });
  if (r.refusal) die(r.refusal);
  return r.ledger;
}

function reportBuilt(ledger) {
  saveLedger(ledger);
  process.stdout.write(renderLedger(ledger));
  const branch = windowBranch(ledger.window);
  const pushed = gitIn(repoDir)
    .run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    ?.trim();
  if (!pushed) {
    console.log(`\nValidate it once, as one pull request whose ci-passed is the whole gate:`);
    console.log(`  git push origin ${ledger.chain.head}:refs/heads/${branch}`);
    console.log(
      `  gh pr create --base ${ledger.base.branch} --head ${branch} --body-file ${ledgerPath.replace(/\.json$/, '.md')}`,
    );
  } else if (pushed === ledger.chain.head) {
    console.log(`\norigin/${branch} already carries this chain head; read its ci-passed there.`);
  } else {
    console.log(
      `\nReplace the chain origin/${branch} carries (${pushed}) on its open pull request. The lease refuses if anyone moved it since:`,
    );
    console.log(
      `  git push --force-with-lease=refs/heads/${branch}:${pushed} origin ${ledger.chain.head}:refs/heads/${branch}`,
    );
  }
  console.log(`Ledger: ${ledgerPath}`);
  process.exit(ledger.members.every((m) => m.landing) ? 0 : 1);
}

if (verb === 'fire') {
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) die(`--now ${values.now} is not a readable time`);
  const r = decideFire({ members: manifest.members, thresholds: manifest.thresholds, now });
  if (r.refusal) die(r.refusal);
  console.log(
    r.fired
      ? `fired on ${r.by.join('; ')}`
      : `not fired: ${manifest.members.length} member(s), oldest waited ${Math.floor(r.waitedMinutes)} minute(s)`,
  );
  process.exit(r.fired ? 0 : 1);
}

if (verb === 'admit') {
  const ready = prepareWindow({ repoDir, manifest });
  if (ready.refusal) die(ready.refusal);
  const judged = admitMembers({ ...ready, members: manifest.members, readCheck });
  for (const m of judged) {
    console.log(
      m.refusals.length === 0
        ? `admitted  ${m.issue}`
        : `refused   ${m.issue}\n${m.refusals.map((x) => `  ${x}`).join('\n')}`,
    );
  }
  process.exit(judged.every((m) => m.refusals.length === 0) ? 0 : 1);
}

if (verb === 'assemble') reportBuilt(build(treeDir));

if (verb === 'isolate') {
  if (!values.member || !values.because)
    die('isolate needs --member <ISS-n> and --because "<the refusal, in the checker\'s words>"');
  if (!manifest.members.some((m) => m.issue === values.member))
    die(`${values.member} is not a member of window ${manifest.window}`);
  const recorded = loadLedger();
  if (resolve(recorded.chain.tree) !== treeDir) {
    die(
      `--tree ${treeDir} is not the tree window ${manifest.window} was built in (${recorded.chain.tree})`,
    );
  }
  const kept = (manifest.isolated ?? []).filter((i) => i.issue !== values.member);
  const next = {
    ...manifest,
    isolated: [
      ...kept,
      {
        issue: values.member,
        because: values.because,
        kind: 'refusal',
        at: new Date().toISOString(),
      },
    ],
  };
  const before = recorded.attributions;
  removeTree(treeDir);
  const ledger = build(treeDir, next);
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  ledger.attributions = before;
  reportBuilt(ledger);
}

if (verb === 'attribute') {
  const ledger = loadLedger();
  if (!existsSync(ledger.chain.tree)) {
    die(`the window's tree ${ledger.chain.tree} is gone; rebuild it with isolate or assemble first`);
  }
  const landed = ledger.members.filter((m) => m.landing);
  const t = gitIn(ledger.chain.tree);
  const found = [];
  for (const p of values.path ?? []) {
    const changed = (landing) =>
      (t.run(['diff', '--name-only', `${landing}^1`, landing, '--', p]) ?? '').trim() !== '';
    found.push({ subject: p, ...ownerOfPath({ landed, changed }) });
  }
  if (values.unit) {
    const repeat = Number(values.repeat ?? 1);
    if (!Number.isInteger(repeat) || repeat < 1)
      die(`--repeat ${values.repeat} is not a whole number of runs`);
    const baseTree = `${treeDir}-replay-base`;
    gitIn(repoDir).must(['worktree', 'add', '-q', '--detach', baseTree, ledger.base.sha]);
    const base = replay(values.unit, baseTree, repeat);
    removeTree(baseTree);
    const members = landed.map((m) => {
      const alone = `${treeDir}-replay-${m.issue.toLowerCase()}`;
      const one = {
        ...manifest,
        members: [{ issue: m.issue, branch: m.branch, head: m.head, arrivedAt: m.arrivedAt }],
        isolated: [],
      };
      const rebuilt = build(alone, one, {
        base: ledger.base.sha,
        branches: ledger.members.map((x) => x.branch),
      }).members[0];
      if (!rebuilt.landing) {
        removeTree(alone);
        return {
          issue: m.issue,
          failed: false,
          unbuilt: rebuilt.isolated?.because ?? 'not rebuilt',
        };
      }
      const r = replay(values.unit, alone, repeat);
      removeTree(alone);
      return { issue: m.issue, ...r };
    });
    const window = replay(values.unit, ledger.chain.tree, repeat);
    found.push({
      subject: values.unit,
      ...classifyReplay({ base, members, window }),
      runs: { base, members, window },
    });
  }
  if (found.length === 0) die('attribute needs --path <p> or --unit "<command>"');
  for (const f of found)
    console.log(`${f.subject}: ${f.kind}${f.owner ? ` — ${f.owner}` : ''}. ${f.says}`);
  ledger.attributions = [...(ledger.attributions ?? []), ...found.map(({ runs, ...a }) => a)];
  saveLedger(ledger);
  process.exit(0);
}

if (verb === 'land') {
  const ledger = loadLedger();
  const plan = planLanding({ repoDir, ledger, readCheck });
  ledger.validation = plan.validation;
  saveLedger(ledger);
  if (plan.refusals.length > 0) {
    console.error(`verify-window: window ${ledger.window} may not land:`);
    for (const r of plan.refusals) console.error(`  ${r}`);
    process.exit(1);
  }
  console.log(
    `Window ${ledger.window}: validated at ${ledger.chain.head}, landing on ${ledger.base.branch} at ${ledger.base.sha}`,
  );
  for (const l of plan.lines) console.log(l);
  process.exit(0);
}

die(`unknown verb \`${verb}\`\n${USAGE}`);
