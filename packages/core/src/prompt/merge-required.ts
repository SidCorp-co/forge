/**
 * ISS-232 — merge-required prompt injection.
 *
 * When the dispatcher builds a prompt for a job whose `stageStatus` matches
 * `project.pipelineConfig.mergeStates.baseBranch` (or `.productionBranch`),
 * we inject a block at the top of the user prompt instructing the skill to
 * merge + push BEFORE issuing the final status transition. Without this
 * step, `issues.merged_at` would never get stamped — the state-machine
 * writer keys on the previous status matching `baseBranch`, but if the skill
 * doesn't actually merge, the parent's children would unblock anyway (wrong
 * semantically) or — when the skill aborts the transition — stay forever
 * blocked.
 *
 * The block is plain text (no Markdown trick / priority system); the skill
 * reads it as part of the regular user prompt.
 */

import type { IssueStatus } from '../db/schema.js';
import type { MergeStatesConfig } from '../issues/merged-at.js';

export interface BuildMergeRequiredBlockArgs {
  /** Stage status (issue.status at dispatch time). Skipped when null. */
  stageStatus: IssueStatus | null | undefined;
  /** Resolved `pipelineConfig.mergeStates` for the project. */
  mergeStates: MergeStatesConfig;
  /** Issue id used in the merge command examples. */
  issueId: string;
}

/**
 * Returns the merge-required block text, or `null` when the stage doesn't
 * require a merge (every stage except `mergeStates.baseBranch` /
 * `.productionBranch`).
 */
export function buildMergeRequiredBlock(args: BuildMergeRequiredBlockArgs): string | null {
  if (!args.stageStatus) return null;
  const matchedBase = args.stageStatus === args.mergeStates.baseBranch;
  const matchedProd = args.stageStatus === args.mergeStates.productionBranch;
  if (!matchedBase && !matchedProd) return null;

  // Trunk-based: baseBranch === productionBranch — emit one block. Otherwise
  // emit a block for each branch the stage matches.
  const branches: Array<{ label: 'baseBranch' | 'productionBranch'; ref: string }> = [];
  if (matchedBase) {
    branches.push({ label: 'baseBranch', ref: args.mergeStates.baseBranch });
  }
  if (matchedProd && args.mergeStates.productionBranch !== args.mergeStates.baseBranch) {
    branches.push({ label: 'productionBranch', ref: args.mergeStates.productionBranch });
  }

  const lines: string[] = [];
  for (const b of branches) {
    lines.push(`## Merge required (this stage → ${b.label})`);
    lines.push('');
    lines.push(
      `This stage is configured as the merge point for the project's \`${b.label}\` (state \`${b.ref}\`).`,
    );
    lines.push('Before transitioning the issue forward you MUST:');
    lines.push('');
    lines.push(`1. Ensure issue \`${args.issueId}\` branch is fully committed and pushed to origin`);
    lines.push(`2. \`git checkout ${b.ref} && git pull origin ${b.ref}\``);
    lines.push(`3. \`git merge --no-ff origin/<issue-branch>\` (or fast-forward if linear)`);
    lines.push(`4. \`git push origin ${b.ref}\``);
    lines.push('5. Verify the merge commit exists on remote before issuing the final status transition');
    lines.push(
      `6. Stamp \`merged_at\` so downstream \`blocks\`/\`decomposes\` dependents can dispatch: \`forge_issues.mark_merged({ issueId: "${args.issueId}", target: "${b.label === 'productionBranch' ? 'prod' : 'base'}" })\` (idempotent). Do this even when you then PARK the issue at a manual gate instead of advancing — the automatic stamp fires ONLY when the issue LEAVES \`${b.ref}\`, so a merged-but-parked issue would otherwise never unblock downstream. Forge does not merge or stamp server-side; this step is yours.`,
    );
    lines.push('');
    lines.push(
      'Failure to complete the merge (or to stamp `merged_at`) means downstream issues (blocks/decomposes) will never unlock.',
    );
    lines.push(
      `If the merge fails, do NOT advance the issue status — keep it on \`${b.ref}\` and post a comment with the failure reason.`,
    );
    lines.push('');
  }
  // Drop trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
