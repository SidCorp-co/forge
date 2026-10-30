import { CLEANUP_REFUSAL_CODES, IMPACT_TYPES } from '@forge/contracts/cleanup';
import type { CoreGuide } from './types.js';

const types = IMPACT_TYPES.map((t) => `\`${t}\``).join(', ');
const codes = CLEANUP_REFUSAL_CODES.filter((c) => c !== 'CLEANUP_REFUSED')
  .map((c) => `\`${c}\``)
  .join(', ');

/** REQ-79: what a building run and a cleanup run record under fast delivery, every project's default. */
export const FAST_DELIVERY_GUIDE: CoreGuide = {
  slug: 'fast-delivery',
  audience: 'agent',
  title: 'Fast delivery: rate the change, leave debt to the cleanup run',
  summary:
    "Every project delivers fast unless its document says `delivery.fast: false`: a change lands when it builds, deploys healthy and its scoped tests pass; the building run rates the change's impact and leaves a non-severe red as cleanup debt; only a change rated high waits for a green cleanup before production; the cleanup run works the debt in its own window and reports what it cleared and what remains.",
  version: 1,
  body: `## Fast delivery: rate the change, leave debt to the cleanup run

Fast delivery is every project's default. A project turns it off with \`delivery.fast: false\` in its
project document, and then every door below behaves as it did before: a merge check asks every check,
a red is fixed in its issue, and nothing waits on a cleanup.

### The building run
- **Land on build and scoped tests.** A merge check on a project delivering fast needs
  \`rebased-on-base\`, \`typecheck\` and \`direct-tests\`; integration tests, \`verify\` and the rest
  are the cleanup run's. Deploy health stays the release's own gate.
- **Rate the change.** Before you mark the merge, record its system impact:
  \`POST /api/issues/:id/impact\` \`{ type, rating, reason, commit? }\`, \`type\` the surface it
  touches (${types}), \`rating\` \`low\`, \`medium\` or \`high\` (high covers severe), \`reason\` why.
  A merge check report may carry the same as \`impact\`. Rate a migration, a kernel or permission
  change, or anything that can take the app down \`high\`; such a change waits for a green cleanup
  before production while every lower one goes now. A change nobody rated waits for nothing, so rate
  every one. The rating also decides what you fix inside the issue: there is no fixed list.
- **Leave a non-severe red as debt.** A red you rate below high, whether your change caused it or
  not, passes and is recorded as cleanup debt:
  \`POST /api/projects/:id/debts\` \`{ issue, items: [{ kind: red | debt | simplify, check, where, detail, impact: { type, rating, reason } }] }\`,
  or, in a merge check report, \`debts\` naming each red check by its \`check\` name. A red you rate
  high holds the issue and is fixed in it (\`DEBT_RED_HOLDS_THE_ISSUE\`). Debt you saw and did not
  cause, or code worth simplifying, is recorded the same way, as \`debt\` or \`simplify\`.

### The cleanup run
The project's cleanup window is its \`cleanup\` schedule, saved at end of day (\`0 18 * * *\` UTC) the
first time there is something to clean; a person re-times it like any schedule. Its fire starts one
run on a slot of its own, never a delivery run's: a fire while the last cleanup run is live starts
nothing (\`CLEANUP_RUN_LIVE\`), and a window with nothing open starts nothing. The run is briefed with
the open debt and the changes waiting on it, and:
1. reads the ledger, \`GET /api/projects/:id/debts\` (open and cleared debt, the changes rated high
   waiting, the window);
2. clears debt and CI red, and simplifies, in its own worktree, landing as the project lands work;
3. reports once, last: \`POST /api/projects/:id/cleanup-reports\`
   \`{ fire, base: { branch, sha }, result: green | red, ci?, cleared: [{ debt, how }], remains: [{ debt, why }], covers }\`.
   Every open debt is named once, cleared with how or remaining with why. \`covers\` names the issues
   rated high whose merge the green head carries, checked with \`git merge-base --is-ancestor\`; only a
   green report covers anything, and covering lets them reach production.

Refusals: ${codes}. A release that would carry a change still waiting is refused
\`RELEASE_CLEANUP_PENDING\`, and the release sweep holds that change under the same code while it cuts
the rest.`,
};
