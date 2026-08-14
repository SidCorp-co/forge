// The conformance tier of the capability-guide registry, split out of
// registry.ts on size grounds. Same shape, same consumers.
//
// Altitude (NT1): teach an agent how to behave when a gate says something
// inconvenient. Not what each checker measures — scripts/README.md owns that.

import type { ForgeGuide } from './registry.js';

// cm:edge lockstep -> packages/core/src/guides/registry.ts — must appear in FORGE_GUIDES there or it is unreachable; the registry test asserts every slug is unique and reachable
export const CONFORMANCE_GUIDE: ForgeGuide = {
  slug: 'conformance-and-verify',
  title: 'Conformance gates & `pnpm verify`',
  summary:
    'Run verify before you claim a step is done, and what each exit code obliges you to do — especially exit 2, which is never a pass.',
  version: 1,
  body: `## Conformance gates & \`pnpm verify\`

A Forge-managed repo may carry conformance gates: one checker per axis, one command that runs them all, and CI jobs that block a merge. \`pnpm verify\` (or the repo's equivalent — check its \`package.json\`) is the entrypoint. It works from a bare checkout with no plugin installed, which is exactly why it, and not a hook, is what your work is judged by.

### When to run it

Run it **before you report a step complete** — code, fix, review, test. Not "if there's time". A step that reports done without a green verify is a claim nobody checked.

Hooks may run some of this for you. Do not depend on that: hooks need a plugin or a local install, and a contributor without either is held to the same bar you are.

### Three exit codes, three different obligations

| Exit | Means | What you must do |
|---|---|---|
| \`0\` | clean | proceed |
| \`1\` | violations | fix the **code**, run again |
| \`2\` | the check **could not run** | fix the **gate** — and never report this as a pass |

Exit \`2\` is the one agents get wrong. It does not mean "no problems found". It means a checker's scope resolved to nothing, its tool was missing, or its config was unreadable — so it looked at nothing and has no opinion. Reporting that as green is worse than having no check at all, because the next reader now believes the axis is defended.

### "Pre-existing" and "already red" are not exits

If verify or CI is red on something you did not cause:

1. **In reach and inside your ownership line** — fix it, whoever caused it, whether or not it is in your acceptance criteria.
2. **Out of reach** — it leaves as someone's work: an issue at \`draft\`, a \`blocks\` edge, or a comment carrying the evidence.

What is never acceptable is disclosing it and moving on. Measured on this repo: five test-stage runs wrote *"lint remains red only on pre-existing, untouched diagnostics"* and merged — while a required check was red and an integration suite had five failures, one of them a regression suite that had never run anywhere. Nobody lied and nobody fixed it. "Already red" only means earlier steps dodged too.

### Re-baselining is allowed, silently re-baselining is not

Most checkers freeze today's debt in a baseline and fail only on growth. When growth is legitimate — a file you deliberately extended, a flow you just declared — re-freeze it:

\`\`\`
node scripts/check-<axis>.mjs --update-baseline
\`\`\`

Then **say so in the commit message and name what moved**. The changed numbers in the diff are the record; a re-baseline mentioned nowhere reads as a cleanup that never happened. Never re-baseline to make an unexplained red go away — find out why it went red first.

### Read the advisory before you edit

A full verify run prints the declared couplings on every file you changed — \`cm:guard\` (invariants you must obey), \`cm:edge\` (files that must change together), \`cm:flow\` (runtime steps). This is the pull-side replacement for context injection and it works with nothing installed. If an edge's other side needs the same change, make it now rather than leaving the pair inconsistent.

### Cardinal rules

1. **A check that cannot run must never report clean.** If you find one that does, that is a defect worth fixing before the work you came for.
2. **Running is not gating.** A CI job that exists but is not asserted by the merge gate blocks nothing. If you add a check to CI, confirm it is both listed in the gate's dependencies and named in its result assertion.
3. **Do not add a rule to an axis another tool already owns.** Two configs on one rule drift apart.
4. **Never weaken a gate to get green.** Lowering a threshold, deleting a check, or widening an ignore to pass is a change to the repo's guarantees — it needs a human decision, not a workaround.
`,
};
