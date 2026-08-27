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

import type { BranchConfig } from '../branches/resolve.js';
import type { IssueStatus } from '../db/schema.js';
import type { MergeStatesConfig } from '../issues/merged-at.js';

export interface BuildMergeRequiredBlockArgs {
  /** Stage status (issue.status at dispatch time). Skipped when null. */
  stageStatus: IssueStatus | null | undefined;
  /** Resolved `pipelineConfig.mergeStates` for the project. */
  mergeStates: MergeStatesConfig;
  branches: BranchConfig | null;
  /** A project-owned skill supplies the stage's merge procedure. */
  stageOwnsMergeProtocol: boolean;
  /** Issue id used in the merge command examples. */
  issueId: string;
}

/**
 * Returns the merge-required block text, or `null` when the stage doesn't
 * require a merge (every stage except `mergeStates.baseBranch` /
 * `.productionBranch`).
 */
// cm:flow release/instruct after:enqueue — the merge is the agent's to perform; this block is the ONLY place the server states which branches must move, and it verifies nothing afterwards
export function buildMergeRequiredBlock(args: BuildMergeRequiredBlockArgs): string | null {
  if (!args.stageStatus) return null;
  const matchedBase = args.stageStatus === args.mergeStates.baseBranch;
  const matchedProd = args.stageStatus === args.mergeStates.productionBranch;
  if (!matchedBase && !matchedProd) return null;

  const branches: Array<{
    label: 'baseBranch' | 'productionBranch';
    state: IssueStatus;
    ref: string | null;
  }> = [];
  if (matchedBase) {
    branches.push({
      label: 'baseBranch',
      state: args.mergeStates.baseBranch,
      ref: args.branches?.targetBranch ?? null,
    });
  }
  if (
    matchedProd &&
    (args.mergeStates.productionBranch !== args.mergeStates.baseBranch ||
      args.branches?.prodBranch !== args.branches?.targetBranch)
  ) {
    branches.push({
      label: 'productionBranch',
      state: args.mergeStates.productionBranch,
      ref: args.branches?.prodBranch ?? null,
    });
  }

  const lines: string[] = [];
  for (const branch of branches) {
    lines.push(`## Merge required (this stage → ${branch.label})`);
    lines.push('');
    lines.push(
      `This stage is configured as the merge point for the project's \`${branch.label}\` (state \`${branch.state}\`).`,
    );
    if (args.stageOwnsMergeProtocol) {
      lines.push(
        'The registered project skill owns the git merge procedure. Follow its procedure and verify the merge commit exists on the configured remote target before the final status transition.',
      );
    } else if (branch.ref) {
      lines.push('Before transitioning the issue forward you MUST:');
      lines.push(
        `1. Ensure issue \`${args.issueId}\` branch is fully committed and pushed to origin`,
      );
      lines.push(`2. \`git checkout ${branch.ref} && git pull origin ${branch.ref}\``);
      lines.push('3. `git merge --no-ff origin/<issue-branch>` (or fast-forward if linear)');
      lines.push(`4. \`git push origin ${branch.ref}\``);
      lines.push(
        '5. Verify the merge commit exists on remote before issuing the final status transition',
      );
    } else {
      lines.push(
        'No resolved git ref is configured for this merge target. Do not emit a git command; inspect `forge_step_start` branchConfig and report the misconfiguration.',
      );
    }
    lines.push(
      `Stamp \`merged_at\` so downstream \`blocks\`/\`decomposes\` dependents can dispatch: \`forge_issues.mark_merged({ issueId: "${args.issueId}", target: "${branch.label === 'productionBranch' ? 'prod' : 'base'}" })\` (idempotent). Do this even when you then park the issue at a manual gate instead of advancing — the automatic stamp fires only when the issue leaves the merge state, so a merged-but-parked issue would otherwise never unblock downstream. Forge does not merge or stamp server-side; this step is yours.`,
    );
    lines.push('');
    lines.push(
      'Failure to complete the merge (or to stamp `merged_at`) means downstream issues (blocks/decomposes) will never unlock.',
    );
    lines.push(
      `If the merge fails, do NOT advance the issue status — keep it on state \`${branch.state}\` and post a comment with the failure reason.`,
    );
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
