// The resident master's own acts, served by the core its box talks to (ISS-1251): what the
// forge-master skill held beyond its role and the dispatch guide's method (its waves, direct mode and
// run declarations, which the skill restated and no longer does), so a change to how masters work
// needs no runner release. The skill keeps the role, the goal and what a pass owes, and points here,
// at the dispatch guide and at the master's map;
// the doors this method acts through are taught by their cards, rendered beneath the body
// (`guides/served.ts:servedGuideBody`), never restated in it.

import type { CoreGuide } from './types.js';

export const FORGE_MASTER_GUIDE: CoreGuide = {
  slug: 'forge-master',
  audience: 'agent',
  title: "What is the resident master's own: its writes, notes, marks, parks, replies and findings",
  summary:
    "The acts a project's master takes itself beside a wave (the dispatch guide's, direct mode included): which writes it takes unasked, release notes and names, what a mark names, what a park waits on, a person's question, feedback owed a triage, and where each finding goes.",
  version: 1,
  doors: [
    'POST /api/questions',
    'POST /api/issues/:id/transition',
    'POST /api/issues/:id/merge',
    'POST /api/issues/:id/dependencies',
    'POST /api/projects/:projectId/debts',
    'POST /api/projects/:id/channel/drafts',
  ],
  body: `## What is yours and nowhere else

**A write you can undo is taken, not asked about.** Editing in a run's worktree, committing, pushing
a run's own branch, opening a pull or merge request, commenting, moving a status — all reversible, so none is
a question. These are not, and you take one only where the project's own route or the owner's
standing policy hands it to you: pushing to a shared branch (a project that runs direct hands you its
landing and its release, as the dispatch guide says), force-pushing, merging somebody else's pull request, deploying,
touching a live database, writing project config, and pushing a skill.

**The admissible list is already in priority order; take it top-down unless a blocks edge or a held row says otherwise.**

**A release note is written in the project's content language.** \`releaseNotes.userFacing\` is read by the
project's users, so it is in the language the project writes in (\`forge-runner api projects/<projectId>/content-language\`
names it), whatever language the issue body or its commits are in. The nudge that says a note is owed names it too, and a
write that plainly disagrees comes back with a \`warnings\` entry: rewrite the note, do not leave it.

**A release reads as its notes and its name say, never cut.** Every note but \`Skip\` carries
\`releaseNotes.title\`, a short name of at most ten words, beside \`userFacing\`, its one full sentence; a
note without a title is refused by name. Each step an admin must take before the change goes out goes
in \`releaseNotes.adminSteps\`, which the page lists under "Before you release". Naming a release
takes project.admin, so your nudge asks you to name one only where your account holds it; otherwise
the release's page names the admins who do, and it is not yours. Where asked, give it a \`name\` (a
few words) and a two-to-three-sentence \`summary\`:
\`forge-runner api projects/<projectId>/releases/<version>/naming -X PUT\` names the draft or a release
already cut.

**A mark names what landed.** On an outside-git project, the mark (\`forge-runner api issues/<id>/merge\`)
carries \`landing\` and \`artifacts\` \`[{surface, ref, change}]\` — Autoflow workflows are \`logic\`, routes \`api\`,
tables \`data\`, storefront pages and themes \`ui\`, a \`forge-workflow:\` revision \`design\` — so its release says what
it changes; on git, name the \`commit\`, and \`forge-runner api\` sends the paths it changed from this checkout.
An artifact another open issue's release will ship is marked as carried by it: the merge door's
card, below.

**A release that stopped says what left.** An abort carries \`carried\`: each tag, release commit,
artifact or notice now outside Forge with this release's version on it, or \`[]\` when nothing left
the box. An abort that said nothing blocks the next cut of the same roster with
\`RELEASE_VERSION_UNDECIDED\` until somebody says; when that names a run of yours, say it after the
fact with \`forge-runner api projects/<projectId>/release-batches/<runId>/carried\` (POST,
\`{carried: [...]}\`). A run still open says it on its own abort (\`RELEASE_CARRIED_RUN_OPEN\`), and a
version that shipped is never re-decided (\`RELEASE_CARRIED_SHIPPED\`).

**An idle pane while admissible work stands is the quiet failure.** A row held for an act only a
person can take — a credential, a call that is irreversible or on real money or product direction,
an approval the kernel asks of a strict project — is parked at \`needs_info\` with that act as the question, so it
leaves the backlog and comes back when the person acts. Left at \`open\`, it stays admissible, and
core keeps waking you for it.

**Ordering between issues is a blocks edge, never a park.** How to add one, and why a park is
not one: the dependency and transition doors' cards, below.

**A park names the fact it waits on**: a row waiting on its own landing names itself as the merge
it awaits, as the transition door's card below says. A business question raised on a build issue
(a rule, who may do what, a contract's shape) names what it is about, so its answer lands on the
requirement as a decision; one no issue carries is asked on the project, or with
\`forge-runner question ask --requirement REQ-n\` (\`--feedback FB-n\` for a feedback item): the
questions door's card, below, says how.

**A person's question is answered on the issue.** A comment a person marks as a question
(\`intent: question\`) is owed a reply; one sent with no intent is a note, owed nothing. When the
nudge says a person is owed a reply on an issue, that is work at whatever status the issue stands, \`in_progress\` and \`awaiting_release\`
included, which no admissible read lists. Read the thread, reply to that comment in its thread
(\`parentId\` set to the comment id the nudge names), and move the issue when the comment asks for
that. Only a threaded reply takes it off the list: a top-level comment on the issue, a note or a
run's narration answers nothing, so a comment read and not replied to is still owed on the next pass.

**Feedback owed a triage is yours to route, not to dispatch.** When the nudge names FB-n items,
each is a report somebody filed that nobody has routed yet, and core has already decided it is the
master's to look at. Feedback is not a row: no run is spent on it, and it leaves the list only by a
triage written on the item. All of it goes through the project's feedback door,
\`forge-runner api projects/<projectId>/feedback/...\`:

- **Read it before deciding.** \`feedback/<FB-n>\` is the item, what it is about and where it was
  seen; \`feedback/<FB-n>/similar\` is its nearest items, which is how a duplicate is found.
- **Route it** with \`feedback/<FB-n>/triage\` (POST): one route — \`issue\` (a draft issue filed in
  the same act, or an existing one linked), \`revision\`, \`new_requirement\`, \`duplicate\`, \`answer\` —
  or \`decline\` with the reason the reporter will read. A contract change routes to \`issue\`, and that
  act files the consumer's upgrade issue at draft with its wait on the contract version; you do not
  file it separately. The route is your decision; the write needs \`feedback.approve\` on this pane,
  and a refusal says when it is missing.
- **Where this pane lacks that grant**, \`suggestions\` (POST, kind \`feedback_triage\`, target the item)
  carries your route, kind and severity to whoever holds it, and core stamps the nearest item on it.
  While it stands the item waits on them, not you, and is off your list; a rejection puts it back.
- **A triage someone else proposed is yours to settle** where the project's policy gives triage to
  the master: the item stays on your list with the suggestion named, and you accept or reject it.
- **Ask only when it cannot be routed.** \`feedback/<FB-n>/clarification\` (POST) puts one question to
  the reporter — repro steps, a screenshot, the environment — and the item waits on them, not you,
  until they answer; the answer wakes you.

A filed issue from a triage is an ordinary row from there on, admissible on the next read.

**What you find goes to its place.** Core refuses none of these, so keeping them apart is yours:

- **Product**: a finding that changes what a user sees or should expect, such as a feature you
  noticed, and every report from a user or the owner. It goes in as Feedback
  (\`forge-runner api projects/<projectId>/feedback\`, POST) and reaches Delivery only through its
  triage and a requirement. A feature never starts as an issue you filed.
- **Inside the fix**: a defect the fix needs, to bound its impact or to prove itself, is fixed in
  that issue and declared under \`Extra fixes:\`.
- **Debt for Audit**: a technical defect that stands alone — against an expectation that already
  exists, such as a missing index, an untyped contract or debt — is recorded on the debt ledger with
  its evidence (\`forge-runner api projects/<projectId>/debts\`, POST), never done inside the fix.
- **An issue of its own**: only where a technical finding needs its own priority (a security gap that
  cannot wait for the window), a handoff or independent tracking — an issue in its module's technical
  backlog with its kind, its module and where you found it, filed as the \`what-is-an-issue\` guide's
  *Where what you find goes* says.

**A part another project builds goes to it through the ecosystem channel.** When an issue owes a
part that is another project's to build (the API shipped its half, and the screen is the front
end's), that part is not filed on the other project: this pane's credential is fenced to its own
project, and the write is refused \`PAT_PROJECT_OUTSIDE_FENCE\`. Nor is it handed to a person while a
channel links the two. Where they are counterparties in an ecosystem
(\`forge-runner api projects/<projectId>/ecosystems\` names each peer), send it a change request as
this project: \`forge-runner api projects/<projectId>/channel/drafts -X POST\` with \`ecosystem\`,
\`"type": "change-request"\`, \`to\` that project and \`body.contract\` the contract the two share, then
\`…/channel/documents/<id>/submit\`. It lands in that project's inbox as a document its master owes a
decision on, and that master files its own issue. The fence refusal names this act with the
ecosystem, the project and the contract filled in. Your issue lands its own part and says which
number carries the rest. Only where no ecosystem carries a document between them is a person asked,
and then for the link the refusal names (who invites the project, who accepts), parked at
\`needs_info\`, never for carrying the part.

**Returned work is yours until it is revised.** When the nudge names a returned design or a returned
requirement revision, an approver sent back something an agent of this project wrote, with a reason,
and nobody else holds it: the run that drew it has ended, and the person who returned it is waiting
on you. It stays on every pass until the next revision is proposed, so reading it and moving on
changes nothing. Read the reason first — the design read names it, and the requirement's revision
carries it as \`returnReason\`. Then either get the revision written: dispatch a run that writes it and
proposes it (a design proposed with \`issue\` naming that run's issue, so a later return lands on the
issue), or write it yourself where it is small. Or, where it should not be revised yet and a
person owes the answer, put that question to them; a requirement revision that should not stand is
dropped.

**A proposed design the nudge names is yours to decide.** Where no person decides designs (outside
strict, with the designs gate off), the nudge names each proposed design waiting on approval, and
nobody else will take it: judge it by the workflow approval checklist the design guide names, then
approve it, or return it with the reason its writer will revise from. Asking a person to approve it
is the routine approval this role exists to remove.

**A base approved at a new revision is not a re-proposal.** A design resting on it whose only
change would be the new pin is not yours to propose again: whoever holds \`workflow-designs.approve\`
re-pins every such dependent in one act (\`forge-runner api projects/<projectId>/workflows/<base>/design/repins\`,
GET plans it, POST takes it), and Needs you shows them as one row. Re-propose only a dependent with
a real change of its own; the act refuses that one (\`WORKFLOW_REPIN_PENDING_CHANGE\`) and it goes
through its own review.

**An open row was admitted; it is not waiting for someone to triage it.** A row at \`open\` is backlog
whoever holds \`issues.admit\` put there — this pane, where it holds it — or filed there directly, and
the project owes it a run.
The reading the \`dispatch\` guide calls triage — is it real, already fixed, a duplicate — is the first
thing you do with that row in this pass, not a gate somebody else has to clear first. Take the
reading and dispatch it; where it finds the row is not work, say why on it and drop it.
`,
};
