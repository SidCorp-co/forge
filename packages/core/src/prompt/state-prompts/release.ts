/**
 * Default system-prompt block for the `release` step (status: released).
 * See `prompt/state-prompts/triage.ts` for the pattern.
 *
 * The terminal-exit invariant below lives HERE, not in the forge-release skill
 * body, on purpose. Skills are forked per project at adoption and never merge
 * back (`skills/effective.ts` — "every usable skill is a project COPY frozen at
 * adoption time"), so an invariant written into a skill body reaches only the
 * projects bootstrapped after it. anhome ISS-362/ISS-399 stalled at `released`
 * twice against anhome's own forked copy; a fix to the shared template would
 * not have reached it. This block ships with the code and reaches every
 * project on deploy, without touching any project's procedure.
 *
 * Keep the split honest: POLICY that binds every project goes here; PROCEDURE
 * (which branch, whether this stage merges at all, how the changelog is
 * written) stays in the per-project skill.
 */
export const releaseStatePrompt = `## This State — Release (status: released)
Finalize the issue: confirm its code really landed where this project promotes from, record what
shipped, and close it out. Whether this stage merges anything is governed by the project's adopted
forge-release skill, not this default — some projects promote in batches and merge nothing here.
- Verify the land against the REMOTE before declaring success. A push exit code, a branch name, or
  "the previous step said so" is not evidence. \`merged_at\` and the release comment are promises
  other issues act on: a blocks-gate dependent dispatches the moment \`merged_at\` is stamped.
- The close is the only action that stops this stage being re-dispatched. Do it as soon as the land
  is verified, and put nothing that can fail between the two. Branch/worktree cleanup is
  best-effort and belongs AFTER the close — losing cleanup costs a stale branch, losing the close
  wedges the issue and holds a concurrency slot until a human intervenes.
- A re-dispatch means a prior attempt may already have done part of this. Establish what actually
  landed before redoing anything — never blindly re-merge, re-deploy, or re-append a changelog
  entry a previous attempt already wrote.
Exit — exactly one of these, always with a comment. Exiting while the issue is still at
\`released\` is FORBIDDEN, including on a partial or confused run:
- Verified and finalized → set status \`closed\`.
- The code is not where it must be, or won't land cleanly → set status \`reopen\`, naming what is missing.
- Blocked on a human decision → set status \`waiting\`, naming the decision.
If you cannot determine the state, post what you observed and set \`waiting\` — a silent exit at
\`released\` leaves the reconciler re-dispatching this stage forever.`;
