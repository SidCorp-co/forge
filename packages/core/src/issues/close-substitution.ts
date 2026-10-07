// A `NO_OP` names the rewrite that moved the caller's target, and the way out;
// a success a rule stored elsewhere names it too (ISS-1365).
// `resolveAutonomousParkTarget` makes `parked` from `requested`, and
// `resolveAgentCloseTarget` makes `final` from `parked`, so `final !== parked`
// is the release gate's rewrite and equality is the driver's (ISS-1129).

import type { IssueStatus, WaitingKind } from '../db/schema.js';

export type RewriteRule = 'autonomous_driver' | 'release_gate';

/** What a transition answers with where a rule stored a status other than the one asked for. */
export interface TransitionRewrite {
  requested: IssueStatus;
  stored: IssueStatus;
  rule: RewriteRule;
  waitingKind: { sent: WaitingKind | null; stored: WaitingKind | null };
  detail: string;
}

interface RewriteChain {
  requested: IssueStatus;
  parked: IssueStatus;
  final: IssueStatus;
}

function rewriteRule({ requested, parked, final }: RewriteChain): RewriteRule | null {
  if (requested === final) return null;
  return final !== parked ? 'release_gate' : 'autonomous_driver';
}

const RULE_CLAUSE: Record<RewriteRule, string> = {
  autonomous_driver:
    "by this project's autonomous driver, which parks at the one status it can be restarted from",
  release_gate:
    "by this project's release gate, because an agent's close is the release gate's to grant unless the close IS the release",
};

export function describeRewrite(
  input: RewriteChain & { sentKind: WaitingKind | null; storedKind: WaitingKind | null },
): TransitionRewrite | null {
  const rule = rewriteRule(input);
  if (!rule) return null;
  const { requested, final, sentKind, storedKind } = input;
  return {
    requested,
    stored: final,
    rule,
    waitingKind: { sent: sentKind, stored: storedKind },
    detail: `\`${requested}\` was stored as \`${final}\` ${RULE_CLAUSE[rule]}.${keptKind(sentKind, storedKind)}`,
  };
}

function keptKind(sent: WaitingKind | null, stored: WaitingKind | null): string {
  if (sent === null) return '';
  if (sent === stored) return ` The waitingKind \`${sent}\` is kept.`;
  const held = stored === null ? 'none' : `\`${stored}\``;
  return ` The waitingKind \`${sent}\` was not kept; the row stores ${held}.`;
}

export interface NoOpSentenceInput {
  projectId: string;
  requested: IssueStatus;
  parked: IssueStatus;
  final: IssueStatus;
}

export function noOpSentence(input: NoOpSentenceInput): string {
  const { projectId, requested, final } = input;
  const rule = rewriteRule(input);
  if (!rule) return `issue already in status ${final}`;

  const said =
    `\`${requested}\` was rewritten to \`${final}\` ${RULE_CLAUSE[rule]}. ` +
    `The issue is already in status \`${final}\`, which is not the status you asked for.`;
  if (rule === 'autonomous_driver') return said;

  return (
    `${said} Two things reach \`closed\` from here. Run the release: ` +
    `POST /api/projects/${projectId}/release-batches. Or, where the release has already ` +
    `happened and no batch could be created, record it: ` +
    `POST /api/projects/${projectId}/release-records with the whole 40-character sha of the ` +
    `commit production is serving, an ` +
    `account of how it was released, and the issues it carried — core reads this project's live ` +
    `probes itself and refuses the record where they are not serving that commit.`
  );
}
