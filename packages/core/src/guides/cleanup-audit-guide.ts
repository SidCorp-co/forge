// The Audit stage of Product → Delivery → Release → Audit, as the cleanup run works it (REQ-79
// BC-20, BC-23): a job of its own, apart from delivery. Building a change is the delivery runs' job
// and their guides'; reading what they landed and how it ran, cleaning it, and returning what it
// finds to Product is this one's. The cleanup brief (`cleanup/rules.ts:cleanupBrief`) names the
// range and the debt, and points here instead of carrying the method itself.
//
// Altitude (NT1): what to look for, in what order, and what refuses the report.

import type { CoreGuide } from './types.js';

export const CLEANUP_AUDIT_GUIDE: CoreGuide = {
  slug: 'cleanup-audit',
  audience: 'agent',
  title: 'Audit: the cleanup run reads what landed and how it ran',
  summary:
    "The Audit stage, worked by the cleanup run in the project's cleanup window: review the range that landed since the last cleanup report for defects, duplicates, code not reused, patterns that no longer fit, workarounds and leftovers, and read how it ran in real use; merge, reuse and simplify; clear the recorded debt and CI red; record what stays as debt, return what changes the product to Product as Feedback, keep each lesson for retrieval; and report once.",
  version: 2,
  body: `## Audit: the cleanup run reads what landed and how it ran

Forge's loop is Product → Delivery → Release → Audit → Product, and this is Audit: a job of its own,
never a step of delivery. Delivery builds fast, lands batches on the minimum bar and leaves what it
did not clean as recorded debt; Release ships each batch once. Audit runs in the project's cleanup
window, after a period of running: a cleanup run starts there when debt is open, when a change rated
high waits, or when anything landed on the base since the last cleanup report. It cleans what landed
while the product keeps running, and returns what it finds that the product should change to Product.

### 1. Read what you were handed
- **The range.** Your brief names what landed since the last report, \`<from>..<head>\` on the base
  branch. Read it whole before you change anything: \`git log --stat <from>..<head>\`, then the diff
  of each change. Where no report was ever filed, review the recent landings up to the head.
- **The debt.** \`GET /api/projects/:id/debts\` reads every open debt, the evidence kept on each, and
  the changes rated high waiting on a green cleanup. A debt carried under a priced amnesty stays
  until its condition ends; it is not yours to clear or to carry.

### 2. Audit the range
Look for these, in this order, and note each with the file and the change that brought it:
- **Defects.** Logic or code that is wrong: a case the change did not handle, a check that cannot
  fail, an error swallowed.
- **Duplicates.** Two pieces doing one job: a helper written again beside an existing one, a
  component copied and edited, the same query or check in two modules.
- **Code not reused.** New code where the project already has a shared piece for it: a raw button or
  input instead of the shared component, a hand-built table, a fetch written past the module's own
  client, a constant restated instead of imported.
- **Patterns that no longer fit.** A design a later logic change or refactor decision outgrew, and
  code not brought to the project's standard.
- **Workarounds.** A fallback, a widened filter, a skipped test or a special case added to get a
  change through rather than to fix its cause.
- **Leftovers.** Dead components, unused exports and parameters, commented-out code, flags and
  branches nothing selects any more, and docs that no longer match the code.

### 3. Read how it ran
What landed is also judged by how it ran in real use since the last report: wrong answers, the same
question asked again, a fix that was slow to come. Read the feedback filed since then
(\`GET /api/projects/:id/feedback\`) and the issues reopened as defects, and each conversation the
project's channels hold that your brief or its knowledge points you to.

### 4. Optimize
- **Merge** each duplicate into the one piece that stays, and move every caller onto it.
- **Reuse** the shared piece wherever new code rebuilt it, then delete the rebuilt one.
- **Simplify**: replace a workaround with the fix of its cause where that fix is in reach; remove a
  leftover outright. A deleted line is the best outcome.
- **Clear the debt** you were handed and any red on the base, in the same worktree.
- **Keep behaviour.** A cleanup that changes what a user sees or what a route answers is
  development, not cleanup: it goes to Product (below), never into this run's diff.

Land each fix the way the project lands work, with the project's checks run at the head you leave.

### 5. Record what stays, and return the rest
- **To Product**: what you found that changes what a user sees or should expect, from the range or
  from real use, is Feedback (\`POST /api/projects/:id/feedback\`), for the next Product round to
  triage. Audit files no feature as an issue.
- **Lessons**: what a different run on a different issue should know next time, so the same mistake
  does not come back, is kept for retrieval: \`POST /api/memory\` with \`source: 'knowledge'\`, one
  lesson each, after searching for one already there.
- **Debt**: a technical finding you did not fix (too large, or outside this run's reach) is
  recorded as debt: \`POST /api/projects/:id/debts\` \`{ items: [{ kind: debt | simplify, where, detail, impact: { type, rating, reason } }] }\`.
- What you learned about an open debt, keep on it: \`POST /api/projects/:id/debts/:debt/evidence\`
  \`{ evidence }\`.
- Never file an issue for cleanup work: the ledger is where it waits for the next run.

### 6. Report once, last
\`POST /api/projects/:id/cleanup-reports\` \`{ fire, base: { branch, sha }, result, ci?, cleared, remains, covers? }\`,
as your brief words it: \`base.sha\` is the head you leave, which becomes the next window's
\`<from>\`. Every open debt is named once, cleared with how or remaining with why. The report is
green exactly when every debt it leaves is carried; core refuses any other result
(\`CLEANUP_RESULT_DISAGREES\`) and a base the branch does not hold (\`CLEANUP_BASE_NOT_ON_BRANCH\`).`,
};
