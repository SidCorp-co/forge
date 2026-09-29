import { CONFIG_PATH, parseConfig } from './config.mjs';
import { gitIn, showAt } from './git.mjs';

/** The branch a window's combination is pushed to and its one pull request opened from. */
export function windowBranch(window) {
  return `chore/verify-window-${window}`;
}

/**
 * Whether a validated window may land now, and how. Refused where the base or any landed member
 * moved since the combination was built — the validation then describes a tree nobody is landing —
 * where the required check at the chain head is not a success, or where a member's reviewed head
 * is not an ancestor of its landing. It prints the landing and performs none of it.
 * @returns {{ refusals: string[], lines: string[], validation: object|null }}
 */
export function planLanding({ repoDir, ledger, readCheck }) {
  const g = gitIn(repoDir);
  const refusals = [];
  if (
    g.run(['fetch', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']) ===
    null
  ) {
    return {
      refusals: ['git fetch origin did not answer, so whether anything moved cannot be read'],
      lines: [],
      validation: null,
    };
  }
  const baseRef = `origin/${ledger.base.branch}`;
  const baseNow = g.run(['rev-parse', '--verify', '--quiet', baseRef])?.trim();
  if (baseNow !== ledger.base.sha) {
    refusals.push(
      `${baseRef} is at ${baseNow ?? 'nothing'} and the window was built on ${ledger.base.sha}: re-assemble on the new base`,
    );
  }
  const read = parseConfig(
    showAt(g, ledger.base.sha, CONFIG_PATH),
    `${CONFIG_PATH} at ${ledger.base.sha}`,
  );
  if (read.refusal) return { refusals: [...refusals, read.refusal], lines: [], validation: null };
  const landed = ledger.members.filter((m) => m.landing);
  const lines = [];
  for (const [i, m] of landed.entries()) {
    const now = g
      .run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${m.branch}`])
      ?.trim();
    if (now !== m.head) {
      refusals.push(
        `${m.issue}'s ${m.branch} is at ${now ?? 'nothing'} and the window validated ${m.head}`,
      );
    }
    if (!g.ok(['merge-base', '--is-ancestor', m.head, m.landing])) {
      refusals.push(
        `${m.issue}'s reviewed head ${m.head} is not an ancestor of its landing ${m.landing}`,
      );
    }
    lines.push(`  ${i + 1}. ${m.issue}  landing ${m.landing}  reviewed ${m.head}`);
  }
  const check = readCheck(ledger.chain.head, read.config.check);
  const validation = { check: read.config.check, at: ledger.chain.head, ...check };
  if (check.refusal) refusals.push(check.refusal);
  else if (check.state !== 'success') {
    refusals.push(
      `${read.config.check} at the chain head ${ledger.chain.head} is ${check.state}: attribute the refusal before anything lands`,
    );
  }
  lines.push(
    '',
    "Merge the window's one pull request with a merge commit, so each member keeps its own landing:",
    `  gh pr merge ${windowBranch(ledger.window)} --merge`,
    `Its push to ${ledger.base.branch} has two parents, which ci.yml's proved step reads as already proved.`,
  );
  return { refusals, lines, validation };
}
