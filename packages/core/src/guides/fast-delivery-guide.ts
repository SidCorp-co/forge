import { CLEANUP_REFUSAL_CODES, IMPACT_TYPES } from '@forge/contracts/cleanup';
import { guideRef } from './guide-ref.js';
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
    "Every project delivers fast unless its document says `delivery.fast: false`: a change lands when it builds, deploys healthy and its scoped tests pass; the building run rates the change's impact and records what it leaves unclean as cleanup debt; no landing and no promotion waits on a cleanup report; Audit, the cleanup run in its own window, works the debt and reports what it cleared and what remains.",
  version: 8,
  body: `## Fast delivery: rate the change, leave debt to the cleanup run

Fast delivery is every project's default. A project turns it off with \`delivery.fast: false\` in its
project document, and then a merge check asks every check and a red is fixed in its issue.

### The building run
- **Land on build and scoped tests.** A merge check on a project delivering fast needs
  \`rebased-on-base\`, \`typecheck\` and \`direct-tests\`; integration tests, \`verify\` and the rest
  are the cleanup run's. Deploy health stays the release's own gate.
- **Rate the change.** Before you mark the merge, record its system impact:
  \`POST /api/issues/:id/impact\` \`{ type, rating, reason, commit? }\`, \`type\` the surface it
  touches (${types}), \`rating\` \`low\`, \`medium\` or \`high\` (high covers severe), \`reason\` why.
  A merge check report may carry the same as \`impact\`. Rate a migration, a kernel or permission
  change, or anything that can take the app down \`high\`. A change rated high lands as any other
  does: what it leaves unclean is recorded as debt rated high (below), and the cleanup window takes
  it. Rate every one, since the rating is what tells Audit where to look first; it also decides what
  you fix inside the issue: there is no fixed list.
- **Leave a non-severe red as debt.** A red you rate below high, whether your change caused it or
  not, passes and is recorded as cleanup debt:
  \`POST /api/projects/:id/debts\` \`{ issue, items: [{ kind: red | debt | simplify, check, where, detail, impact: { type, rating, reason } }] }\`,
  or, in a merge check report, \`debts\` naming each red check by its \`check\` name. A red you rate
  high holds the issue and is fixed in it (\`DEBT_RED_HOLDS_THE_ISSUE\`). Debt you saw and did not
  cause, or code worth simplifying, is recorded the same way, as \`debt\` or \`simplify\`.
- **The record says what passed.** A passing merge check's record reads \`lane: fast-delivery\`, the
  checks above (\`fast\` on a preview-approved fast-lane change, \`full\` where the project turned fast
  delivery off). Its lead and its \`debts\` field name each red that passed as cleanup debt, by its
  check and the debt's id, so a pass carrying debt never reads as a clean one.

### Nothing waits on Audit
Audit does not gate delivery. No landing waits on a cleanup report, and no promotion or release
does either, whatever the change's rating and whatever the production trigger: a change rated high
lands on the same bar as any other, and its debt waits on the ledger for the cleanup window.

### The cleanup run: Audit
Delivery ends at the landing and the release; Audit is the cleanup run's, a job of its own. The project's cleanup window is its \`cleanup\` schedule, which exists only where a project admin
turned one on (\`POST /api/schedules\` with \`kind: "cleanup"\`, end of day \`0 18 * * *\` UTC is the
usual time); Forge never makes or enables one. Debt is recorded either way, and where no window is on
the ledger says so (\`windowOff\`). A person re-times it like any schedule. Its fire starts one
run on a slot of its own, never a delivery run's: a fire while the last cleanup run is live starts
nothing (\`CLEANUP_RUN_LIVE\`), and a window with nothing open but carried debt starts nothing, unless
anything landed on the base since the last cleanup report. Where nothing else is owed and the base head cannot
be read, the fire is refused \`CLEANUP_BASE_UNCHECKABLE\`, never called nothing to do. The run is
briefed with the open debt and the range that landed, works by
${guideRef('cleanup-audit')}, and:
1. reads the ledger, \`GET /api/projects/:id/debts\` (open and cleared debt, and the window);
2. audits what landed and how it ran, as that guide says: cleans and simplifies it, clears debt and
   CI red in its own worktree, landing as the project lands work, and returns what would change the
   product to Product as Feedback;
3. reports once, last: \`POST /api/projects/:id/cleanup-reports\`
   \`{ fire, base: { branch, sha }, result: green | red, ci?, cleared: [{ debt, how }], remains: [{ debt, why }] }\`.
   \`base.sha\` is the full 40-hex sha of the head it left, which core reads on the project's source
   host: one the branch does not hold is refused (\`CLEANUP_BASE_NOT_ON_BRANCH\`), and so is any base
   on a project whose host cannot be read (\`CLEANUP_BASE_UNCHECKABLE\`). A later report naming the
   same fire supersedes the earlier one, which is kept; the list reads only the current one. Every
   open debt is named once, cleared with how or remaining with why.

The result is not the run's to judge: a report is green exactly when every debt it leaves is
carried, and red when it leaves one that is not (\`CLEANUP_RESULT_DISAGREES\` otherwise). A debt no
change can clear, such as a secret only a person can set, is carried by a project admin as a priced
amnesty, recorded once on the debt: \`POST /api/projects/:id/debts/:debt/carry\`
\`{ trades, costs, endsWhen }\`, withdrawn with \`DELETE\` on the same path. A carried debt remains on
every report until it is cleared, and never turns one red.

Refusals: ${codes}. None of them holds a landing or a promotion.`,
};
