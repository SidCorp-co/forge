// A `NO_OP` names the rewrite that moved the caller's target, and the way out.
// `resolveAutonomousParkTarget` makes `parked` from `requested`, and
// `resolveAgentCloseTarget` makes `final` from `parked`, so `final !== parked`
// is the release gate's rewrite and equality is the driver's (ISS-1129).

import type { IssueStatus } from '../db/schema.js';

export interface NoOpSentenceInput {
  projectId: string;
  requested: IssueStatus;
  parked: IssueStatus;
  final: IssueStatus;
}

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
