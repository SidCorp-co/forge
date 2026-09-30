import { judgeEligibility, parseDiff } from './eligibility.mjs';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Why a member's entry-gate record does not admit it, or `null`. A member opens no pull request
 * of its own, so no check ever reports at its head: the proof it brings is the entry gate its own
 * run passed, at `entry.at`, recorded where `entry.record` says. The window tests combinations and
 * never stands in for that proof, so a record taken at any other commit admits nothing.
 */
export function entryRefusal(m) {
  const e = m.entry;
  if (e === undefined || e === null) {
    return `${m.issue} carries no \`entry\`: a member enters only with the entry gate its own run passed, as \`entry.at\` (the commit) and \`entry.record\` (where that run recorded it)`;
  }
  if (typeof e !== 'object' || Array.isArray(e)) {
    return `${m.issue}'s \`entry\` is not an object of \`at\` and \`record\``;
  }
  if (typeof e.record !== 'string' || e.record.trim() === '') {
    return `${m.issue}'s \`entry\` carries no \`record\`, so nobody can read the entry gate it claims to have passed`;
  }
  if (typeof e.at !== 'string' || !SHA.test(e.at)) {
    return `${m.issue}'s \`entry.at\` must be the full 40-character commit its entry gate passed at, not ${e.at}`;
  }
  if (e.at !== m.head) {
    return `${m.issue}'s entry gate passed at ${e.at} and the window recorded ${m.head}: a gate measured at another commit describes a tree that was never admitted`;
  }
  return null;
}

/**
 * Whether each member may enter: its branch still points at the head the window recorded, its own
 * run's entry gate passed at that head, and its diff touches no ineligible surface.
 * @returns {{ issue: string, refusals: string[] }[]}
 */
export function admitMembers({ g, baseSha, members, config }) {
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
    const entry = entryRefusal(m);
    if (entry) refusals.push(entry);
    const diff = g.run([
      '-c',
      'core.quotePath=false',
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
