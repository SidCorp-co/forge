/**
 * The feature branch an issue's work lives on.
 *
 * `ISS-<seq>` was already the convention everywhere — five call sites derive
 * the same string for display, and the runner's salvage matches a dirty
 * worktree's branch against it. What changed is that core now ASSERTS it
 * instead of describing it: the name is sent as `worktreeBranch`, so the
 * runner cuts the checkout rather than the agent choosing a name core cannot
 * predict. `prompt/merge-required.ts` emitted the literal `origin/<issue-branch>`
 * for exactly as long as core had no name to put there.
 */

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/workspace/worktree.rs — this string becomes the branch AND, with `/` replaced by `-`, the directory `<repo>/.worktrees/<name>`; `create` is create-or-reuse keyed on it, which is the whole reason every stage of one issue lands in the SAME checkout instead of a fresh one per job
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/workspace/salvage.rs — `belongs_to_issue` matches a dirty worktree's branch against the `issueKey` core sends, and both sides derive it from here; two spellings would make salvage refuse with "no dirty worktree matches ISS-n" on a checkout core itself created
export function issueBranchName(issSeq: number): string {
  return `ISS-${issSeq}`;
}
