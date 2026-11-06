// The cleanup run's method (REQ-79 BC-20, BC-23): audit what landed since the last report and
// optimize it, apart from development. Building a change is the delivery runs' job and their guides';
// reviewing what they landed, merging and simplifying it and clearing the debt they left is this
// one's. The cleanup brief (`cleanup/rules.ts:cleanupBrief`) names the range and the debt, and points
// here instead of carrying the method itself.
//
// Altitude (NT1): what to look for, in what order, and what refuses the report.

import type { CoreGuide } from './types.js';

export const CLEANUP_AUDIT_GUIDE: CoreGuide = {
  slug: 'cleanup-audit',
  audience: 'agent',
  title: 'Cleanup run: audit what landed, then optimize it',
  summary:
    "The cleanup run's method: review the range that landed on the base since the last cleanup report for duplicates, code not reused, workarounds and leftovers; merge, reuse and simplify; clear the recorded debt and CI red; record what stays as debt; and report once.",
  version: 1,
  body: `## Cleanup run: audit what landed, then optimize it

Development and audit are two jobs. The delivery runs build and land fast, and leave what they did not
clean as recorded debt. A cleanup run starts from the project's cleanup window when debt is open,
when a change rated high waits, or when anything landed on the base since the last cleanup report.
It changes no behaviour: it makes what landed smaller, shared and plain, and leaves the base green.

### 1. Read what you were handed
- **The range.** Your brief names what landed since the last report, \`<from>..<head>\` on the base
  branch. Read it whole before you change anything: \`git log --stat <from>..<head>\`, then the diff
  of each change. Where no report was ever filed, review the recent landings up to the head.
- **The debt.** \`GET /api/projects/:id/debts\` reads every open debt, the evidence kept on each, and
  the changes rated high waiting on a green cleanup. A debt carried under a priced amnesty stays
  until its condition ends; it is not yours to clear or to carry.

### 2. Audit the range
Look for these, in this order, and note each with the file and the change that brought it:
- **Duplicates.** Two pieces doing one job: a helper written again beside an existing one, a
  component copied and edited, the same query or check in two modules.
- **Code not reused.** New code where the project already has a shared piece for it: a raw button or
  input instead of the shared component, a hand-built table, a fetch written past the module's own
  client, a constant restated instead of imported.
- **Workarounds.** A fallback, a widened filter, a skipped test or a special case added to get a
  change through rather than to fix its cause.
- **Leftovers.** Dead components, unused exports and parameters, commented-out code, flags and
  branches nothing selects any more, and docs that no longer match the code.

### 3. Optimize
- **Merge** each duplicate into the one piece that stays, and move every caller onto it.
- **Reuse** the shared piece wherever new code rebuilt it, then delete the rebuilt one.
- **Simplify**: replace a workaround with the fix of its cause where that fix is in reach; remove a
  leftover outright. A deleted line is the best outcome.
- **Clear the debt** you were handed and any red on the base, in the same worktree.
- **Keep behaviour.** A cleanup that changes what a user sees or what a route answers is
  development, not cleanup: leave it as debt with what you found.

Land each fix the way the project lands work, with the project's checks run at the head you leave.

### 4. Record what stays
- What you found and did not fix (too large, outside this run's reach, or a behaviour change) is
  recorded as debt: \`POST /api/projects/:id/debts\` \`{ items: [{ kind: debt | simplify, where, detail, impact: { type, rating, reason } }] }\`.
- What you learned about an open debt, keep on it: \`POST /api/projects/:id/debts/:debt/evidence\`
  \`{ evidence }\`.
- Never file an issue for cleanup work: the ledger is where it waits for the next run.

### 5. Report once, last
\`POST /api/projects/:id/cleanup-reports\` \`{ fire, base: { branch, sha }, result, ci?, cleared, remains, covers? }\`,
as your brief words it: \`base.sha\` is the head you leave, which becomes the next window's
\`<from>\`. Every open debt is named once, cleared with how or remaining with why. The report is
green exactly when every debt it leaves is carried; core refuses any other result
(\`CLEANUP_RESULT_DISAGREES\`) and a base the branch does not hold (\`CLEANUP_BASE_NOT_ON_BRANCH\`).`,
};
