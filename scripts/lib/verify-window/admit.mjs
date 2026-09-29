import { judgeEligibility, parseDiff } from './eligibility.mjs';

/**
 * Whether each member may enter: its branch still points at the head the window recorded, the
 * project's required check is green at that head — the window tests combinations and never stands
 * in for a member's own proof — and its diff touches no ineligible surface.
 * @returns {{ issue: string, refusals: string[] }[]}
 */
export function admitMembers({ g, baseSha, members, config, readCheck }) {
  return members.map((m) => {
    const refusals = [];
    const onRemote = g
      .run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${m.branch}`])
      ?.trim();
    if (!onRemote) {
      refusals.push(
        `${m.issue}'s branch ${m.branch} is not on origin, so the head it was green at cannot be read`,
      );
    } else if (onRemote !== m.head) {
      refusals.push(
        `${m.issue}'s branch ${m.branch} is at ${onRemote} and the window recorded ${m.head}: a green ` +
          'measured before its last commit describes a tree that was never admitted',
      );
    }
    if (g.ok(['merge-base', '--is-ancestor', m.head, baseSha])) {
      refusals.push(
        `${m.issue}'s head ${m.head} is already on the base, so there is nothing of it to land`,
      );
    }
    const check = readCheck(m.head, config.check);
    if (check.refusal) refusals.push(check.refusal);
    else if (check.state !== 'success') {
      refusals.push(
        `${m.issue}'s ${config.check} at ${m.head} is ${check.state}, and a member enters only green at its own head`,
      );
    }
    const diff = g.run([
      'diff',
      '--unified=0',
      '--no-renames',
      '--no-color',
      `${baseSha}...${m.head}`,
    ]);
    if (diff === null)
      refusals.push(
        `${m.issue}'s head ${m.head} has no merge base with ${baseSha} this checkout can read`,
      );
    else
      refusals.push(
        ...judgeEligibility({ issue: m.issue, files: parseDiff(diff) }, config).map(
          (r) => r.message,
        ),
      );
    return { issue: m.issue, refusals };
  });
}
