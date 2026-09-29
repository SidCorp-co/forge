import { existsSync } from 'node:fs';
import { readJournal, readOpenSet } from '../migration-order.mjs';
import { admitMembers } from './admit.mjs';
import { CONFIG_PATH, parseConfig } from './config.mjs';
import { enterMigrations, resolveUnions, rewriteTags, Unreadable } from './entering.mjs';
import { gitIn, showAt } from './git.mjs';
import { windowBranch } from './land.mjs';

/**
 * Build a window's combination: a worktree at the base commit, and on it one `--no-ff` merge
 * commit per member that enters, in the window's order, each re-deriving what the repository
 * orders across branches as it enters. The combination is a validation artifact; the landing is
 * that same chain merged through one pull request (`land.mjs`).
 */

/** A journal's entries; throws `Unreadable` naming `where` when the text is not a journal. */
function entriesOf(text, where) {
  const read = readJournal(text, where);
  if (read.problem) throw new Unreadable(read.problem);
  return read.doc.entries;
}

/** The earlier landed members whose own landing commit changed `path`, latest last. */
export function earlierOwners(t, landed, path) {
  return landed.filter(
    (m) =>
      (t.run(['diff', '--name-only', `${m.landing}^1`, m.landing, '--', path]) ?? '').trim() !== '',
  );
}

function isolate(t, member, because) {
  t.run(['merge', '--abort']);
  t.must(['reset', '--hard', 'HEAD']);
  t.must(['clean', '-fdq']);
  return { ...member, landing: null, isolated: { because, kind: 'assembly' } };
}

/** Merge one member into the combination; its ledger row, landed or isolated. `outside` are the
 * members not in the combination, whose commits a member carrying them would bring back in. */
function enter({ t, config, member, open, landed, outside, window }) {
  const needs = outside.find((m) => t.ok(['merge-base', '--is-ancestor', m.head, member.head]));
  if (needs) {
    return isolate(
      t,
      member,
      `${member.issue} carries ${needs.issue}'s head ${needs.head}, which is not in this window; merging it would bring that change back in`,
    );
  }
  if (t.ok(['merge-base', '--is-ancestor', member.head, 'HEAD'])) {
    const carrier = landed.find((m) =>
      t.ok(['merge-base', '--is-ancestor', member.head, m.landing]),
    );
    return isolate(
      t,
      member,
      `${member.issue}'s head ${member.head} is already in the combination, carried by ${carrier?.issue ?? 'the base'}; it lands with that change, not as a landing of its own`,
    );
  }
  const merge = t.raw(['merge', '--no-ff', '--no-commit', member.head]);
  if (merge.status !== 0 && !/CONFLICT|Automatic merge failed/.test(merge.stdout + merge.stderr)) {
    return isolate(
      t,
      member,
      `git merge of ${member.head} did not run: ${(merge.stderr || merge.stdout).trim()}`,
    );
  }
  const earlier = landed.flatMap((m) => m.renumbered ?? []);
  const mig = enterMigrations({ t, dir: config.migrationsDir, member, open, earlier });
  if (mig.refusal) return isolate(t, member, mig.refusal);
  const unmergedNow = () =>
    (t.run(['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
  const unions = resolveUnions({ t, unmerged: unmergedNow(), union: config.union });
  if (unions.refusal) return isolate(t, member, unions.refusal);
  const conflicted = unmergedNow();
  if (conflicted.length > 0) {
    const named = conflicted.map((p) => {
      const owners = earlierOwners(t, landed, p).map((o) => o.issue);
      return owners.length > 0
        ? `${p} (changed earlier in this window by ${owners.join(', ')})`
        : `${p} (changed on the base)`;
    });
    return isolate(
      t,
      member,
      `${member.issue} conflicts on ${named.join('; ')}; the later admission owns a same-path refusal`,
    );
  }
  const rewrites = rewriteTags(t, mig.retag, config.migrationsDir);
  t.must([
    'commit',
    '-q',
    '-m',
    `verify window ${window}: ${member.issue} (${member.branch} at ${member.head.slice(0, 9)})`,
    '-m',
    `Verify-Window: ${window}\nIssue: ${member.issue}\nReviewed-Head: ${member.head}`,
  ]);
  const landing = t.must(['rev-parse', 'HEAD']).trim();
  return {
    ...member,
    landing,
    renumbered: mig.moves,
    rewrites,
    unions: unions.resolved,
    isolated: null,
  };
}

/**
 * Fetch, then read what every step is judged against: the base commit, the declarations at it and
 * the open branches outside the window, which never include the window's own pushed branch. A
 * `replay` — one member rebuilt for `attribute --unit` — names the window it came from: its base,
 * never wherever the remote has moved since, and every branch of that window.
 * @returns {{ refusal: string } | object}
 */
export function prepareWindow({ repoDir, manifest, replay, rebuild = false }) {
  const g = gitIn(repoDir);
  const trimmed = (args) => g.run(args)?.trim() ?? null;
  if (
    trimmed(['fetch', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']) ===
    null
  ) {
    return {
      refusal: 'git fetch origin did not answer, so neither the base nor any member can be read',
    };
  }
  const baseRef = `origin/${manifest.base}`;
  const baseSha = replay
    ? trimmed(['rev-parse', '--verify', '--quiet', `${replay.base}^{commit}`])
    : trimmed(['rev-parse', '--verify', '--quiet', baseRef]);
  if (!baseSha)
    return { refusal: `${baseRef} does not exist, so there is no base to build the window on` };
  const read = parseConfig(showAt(g, baseSha, CONFIG_PATH), `${CONFIG_PATH} at ${baseSha}`);
  if (read.refusal) return { refusal: read.refusal };
  const config = read.config;
  const pushed = `origin/${windowBranch(manifest.window)}`;
  if (!replay && !rebuild && trimmed(['rev-parse', '--verify', '--quiet', pushed]) !== null) {
    return {
      refusal: `${pushed} already exists, and a fresh window cannot tell it from a stale one: its migrations would be left out of the open set. Name a new window id, or rebuild this one with isolate`,
    };
  }
  const journal = `${config.migrationsDir}/meta/_journal.json`;
  const inWindow = [
    windowBranch(manifest.window),
    ...manifest.members.map((m) => m.branch),
    ...(replay?.branches ?? []),
  ];
  const memberRefs = new Set(inWindow.map((b) => `origin/${b}`));
  let openSet;
  try {
    openSet = readOpenSet({
      git: trimmed,
      journal,
      baseRef,
      baseCommit: baseSha,
      fetch: false,
      isOurs: memberRefs.has.bind(memberRefs),
      parse: entriesOf,
      afterFetch: () => {
        const text = showAt(g, baseSha, journal);
        if (text === null) {
          throw new Unreadable(`the base carries no ${journal}, which its declarations name`);
        }
        return entriesOf(text, `${baseRef}:${journal}`);
      },
    });
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    return {
      refusal: `${err.message}, so the open set is unknown and no migration number can be allocated`,
    };
  }
  if (openSet === null)
    return {
      refusal: 'the open branches could not be enumerated, so no migration number can be allocated',
    };
  if (openSet.hole)
    return {
      refusal: `${openSet.hole.ref}'s ${openSet.hole.kind} could not be read, and an unknown is not an absence`,
    };
  return { g, baseSha, config, open: openSet.open };
}

/**
 * A `replay` (see `prepareWindow`) is not admitted again: the window it came from admitted it.
 * @param {{ repoDir: string, manifest: object, treeDir: string, readCheck: Function,
 *   replay?: { base: string, branches: string[] } }} input
 * @returns {{ refusal: string } | { ledger: object }}
 */
export function assemble({ repoDir, manifest, treeDir, readCheck, replay, rebuild }) {
  const ready = prepareWindow({ repoDir, manifest, replay, rebuild });
  if (ready.refusal) return ready;
  const { g, baseSha, config, open } = ready;
  if (existsSync(treeDir))
    return { refusal: `${treeDir} already exists; a window is built in a tree of its own` };

  const admissions = !replay
    ? admitMembers({ g, baseSha, members: manifest.members, config, readCheck })
    : manifest.members.map((m) => ({ issue: m.issue, refusals: [] }));
  g.must(['worktree', 'add', '-q', '--detach', treeDir, baseSha]);
  const t = gitIn(treeDir);
  const prior = new Map((manifest.isolated ?? []).map((i) => [i.issue, i]));
  const rows = [];
  for (const [i, member] of manifest.members.entries()) {
    const refusals = admissions[i].refusals;
    if (refusals.length > 0) {
      rows.push({ ...member, admission: 'refused', refusals, landing: null, isolated: null });
      continue;
    }
    if (prior.has(member.issue)) {
      rows.push({
        ...member,
        admission: 'admitted',
        refusals: [],
        landing: null,
        isolated: prior.get(member.issue),
      });
      continue;
    }
    const landed = rows.filter((r) => r.landing);
    const outside = manifest.members.filter(
      (m, k) =>
        m.issue !== member.issue &&
        (admissions[k].refusals.length > 0 ||
          prior.has(m.issue) ||
          rows.some((r) => r.issue === m.issue && !r.landing)),
    );
    rows.push({
      admission: 'admitted',
      refusals: [],
      ...enter({ t, config, member, open, landed, outside, window: manifest.window }),
    });
  }
  const head = t.must(['rev-parse', 'HEAD']).trim();
  return {
    ledger: {
      window: manifest.window,
      base: { branch: manifest.base, sha: baseSha },
      thresholds: manifest.thresholds ?? null,
      declarations: `${CONFIG_PATH} at ${baseSha}`,
      openBranches: open.map((b) => b.branch),
      members: rows,
      chain: { head, tree: treeDir, landed: rows.filter((r) => r.landing).length },
      attributions: [],
      validation: null,
    },
  };
}
