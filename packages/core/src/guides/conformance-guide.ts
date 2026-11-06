// The conformance tier of the capability-guide registry, split out of
// registry.ts on size grounds. Same shape, same consumers.
//
// Altitude (NT1): teach an agent how to behave when a gate says something
// inconvenient. Not what each checker measures — scripts/README.md owns that.

import type { CoreGuide } from './types.js';

export const CONFORMANCE_GUIDE: CoreGuide = {
  slug: 'conformance-and-verify',
  audience: 'agent',
  title: 'Conformance gates & `pnpm verify`',
  summary:
    'Where verify sits in a blast-radius verification (narrow checks beside the fix, verify on the integrated batch), what each exit code obliges you to do — especially exit 2, which is never a pass — and where a red you did not cause goes.',
  version: 2,
  body: `## Conformance gates & \`pnpm verify\`

A Forge-managed repo may carry conformance gates: one checker per axis, one command that runs them all, and CI jobs that block a merge. \`pnpm verify\` (or the repo's equivalent — check its \`package.json\`) is the entrypoint. It works from a bare checkout with no plugin installed, which is exactly why it, and not a hook, is what your work is judged by.

### When to run it

Verification follows the blast radius. **Narrow checks sit next to the fix**: the typecheck and lint of what you changed and the tests related to it. **Verify is a wide check**: it runs once per batch, on the integrated change, wherever the project's own gate names it — not after every step. Check wide *early*, before the batch gate, only where your change touches shared logic, billing, permissions or data; line count is a secondary signal. A step that reports done without the checks its blast radius asks is a claim nobody checked.

Hooks may run some of this for you. Do not depend on that: hooks need a plugin or a local install, and a contributor without either is held to the same bar you are.

### Three exit codes, three different obligations

| Exit | Means | What you must do |
|---|---|---|
| \`0\` | clean | proceed |
| \`1\` | violations | fix the **code**, run again |
| \`2\` | the check **could not run** | fix the **gate** — and never report this as a pass |

Exit \`2\` is the one agents get wrong. It does not mean "no problems found". It means a checker's scope resolved to nothing, its tool was missing, or its config was unreadable — so it looked at nothing and has no opinion. Reporting that as green is worse than having no check at all, because the next reader now believes the axis is defended.

### "Pre-existing" and "already red" are not exits — every red has a place

If verify or CI is red, the red goes to exactly one place:

1. **Your fix needs it** to bound its impact or to prove itself — fix it, whoever caused it.
2. **It stands alone** — record it as debt for the Audit, with the check that ended red and its evidence (\`POST /api/projects/:id/debts\`, \`kind: red\`); it is not cleaned inside your fix. A red you rate high is refused as debt and stays the issue's to fix, and on a project that turned fast delivery off every red does.
3. **Out of reach** — routed to whoever owns it: a comment carrying the evidence on the issue that owns it, or a \`blocks\` edge.

What is never acceptable is mentioning it and moving on: a red recorded on the debt ledger is discharged to the Audit, one only mentioned in a comment is not.

### Re-baselining is allowed, silently re-baselining is not

Most checkers freeze today's debt in a baseline and fail only on growth. When growth is legitimate — a file you deliberately extended — re-freeze it:

\`\`\`
node scripts/check-<gate>.mjs --update-baseline
\`\`\`

Then **say so in the commit message and name what moved**. The changed numbers in the diff are the record; a re-baseline mentioned nowhere reads as a cleanup that never happened. Never re-baseline to make an unexplained red go away — find out why it went red first.

### Cardinal rules

1. **A check that cannot run must never report clean.** If you find one that does, that is a defect worth fixing before the work you came for.
2. **Running is not gating.** A CI job that exists but is not asserted by the merge gate blocks nothing. If you add a check to CI, confirm it is both listed in the gate's dependencies and named in its result assertion.
3. **Do not add a rule to an axis another tool already owns.** Two configs on one rule drift apart.
4. **Never weaken a gate to get green.** Lowering a threshold, deleting a check, or widening an ignore to pass is a change to the repo's guarantees — a policy change made on the record with the data that justifies it, never a workaround.
`,
};
