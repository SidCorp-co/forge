// What a `NO_OP` says when the status it compared is not the status the caller
// asked for.
//
// `transitionIssueStatus` rewrites an agent's target twice before it compares:
// `resolveAutonomousParkTarget` moves a park the driver cannot restart from,
// and `resolveAgentCloseTarget` moves a `closed` onto the project's release
// gate. Both rewrites are deliberate. The sentence was not: it read `issue
// already in status awaiting_release` to an agent that had asked for `closed`,
// which is false as written — the issue is in the status the resolver
// substituted, not the one the caller named (ISS-1129).

import type { IssueStatus } from '../db/schema.js';

export interface NoOpSentenceInput {
  projectId: string;
  /** What the caller named. */
  requested: IssueStatus;
  /** After the autonomous park rewrite. */
  parked: IssueStatus;
  /** After the release gate rewrite — the status actually compared. */
  final: IssueStatus;
}

/**
 * The refusal, with the way out in it.
 *
 * A caller that reads "already in the status you asked for" has no next move
 * and no reason to look for one; a caller told which gate moved its target, and
 * what passes that gate, has both.
 */
export function noOpSentence(input: NoOpSentenceInput): string {
  const { projectId, requested, parked, final } = input;
  if (requested === final) return `issue already in status ${final}`;

  const stood = `The issue is already in status \`${final}\`, which is not the status you asked for.`;

  if (final !== parked) {
    return (
      `\`${requested}\` was rewritten to \`${final}\` by this project's release gate, because an ` +
      `agent's close is the release gate's to grant unless the close IS the release. ${stood} ` +
      `Two things reach \`closed\` from here. Run the release: ` +
      `POST /api/projects/${projectId}/release-batches. Or, where the release has already ` +
      `happened and no batch could be created, record it: ` +
      `POST /api/projects/${projectId}/release-records with the commit production is serving, an ` +
      `account of how it was released, and the issues it carried — core reads this project's live ` +
      `probes itself and refuses the record where they are not serving that commit.`
    );
  }

  return (
    `\`${requested}\` was rewritten to \`${final}\` by this project's autonomous driver, which ` +
    `parks at the one status it can be restarted from. ${stood}`
  );
}
