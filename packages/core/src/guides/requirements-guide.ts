import { GOAL_LABEL_WORDS } from '@forge/contracts/requirement-goal';
import { guideRef } from './guide-ref.js';
import type { CoreGuide } from './types.js';
import { TRACE_ACT } from './workflow-design-guide.js';

export const REQUIREMENT_LIFECYCLE_GUIDE: CoreGuide = {
  slug: 'requirement-lifecycle',
  audience: 'agent',
  title: 'Requirements: revisions, agreement, baselines and delivery',
  summary:
    'How a requirement (REQ-n) is written in immutable revisions with stable business criteria (BC-n), proposed, accepted and agreed by a holder of requirements.approve under a baseline pinning its designs, re-pinned, deferred, moved into delivery and to delivered by an act, accepted (by its checklist or by decision) or dropped; and why an issue planned against it reads changed-since-plan.',
  version: 8,
  body: `## Requirements: revisions, agreement, baselines and delivery

A requirement (REQ-n) is the business intent a set of issues delivers. Its text never changes in place:
it lives in numbered revisions, and each revision carries business criteria under stable codes
(BC-1, BC-2, …) that issues trace their own criteria to: an issue criterion traces one where its
line opens with the tag, \`(REQ-n BC-m) <statement>\`, and nowhere else. The door is
\`/api/projects/:id/requirements\`: each act below is a route under \`…/requirements/:req\`
(\`revisions\`, \`revisions/:n/propose|accept|return\`, \`agree\`, \`repin\`, \`defer\`, \`undefer\`,
\`start-delivery\`, \`mark-delivered\`, \`accept\`, \`drop\`, \`issues\`, \`promote\`, \`workflows\`, \`contracts\`, \`verdicts\`).

### Three things move, and they are not one field
- **The requirement's status**: \`draft\` (being written; nothing is built against it), \`agreed\` (a
  revision was signed off under a baseline), \`in_delivery\` and \`delivered\` (each moved there by
  an act, below), \`deferred\` (out of the current release), \`accepted\` (delivered and accepted),
  \`dropped\` (no longer wanted; terminal, so no act brings it back and it takes no new revision,
  rewrite, proposal or accept: \`REQUIREMENT_DROPPED\`, naming a new requirement as the way to carry
  the work, and a draft it held is withdrawn by the drop) and \`refused\` (its value check refused it, below). A status moves
  only by an explicit act of a person, the assistant or an agent; no read derives one from results.
- **Each revision's state**: \`draft → proposed → current → superseded\`. \`current\` is the head, the
  revision that was accepted. A requirement holds **one open revision at a time** (a draft or a
  proposed one): writing a second is \`REQUIREMENT_REVISION_OPEN\`.
- **The delivery read**, never written: the live issues and each current BC's coverage. An agreed
  requirement whose issues all closed and whose every BC passes still reads \`agreed\` until someone
  moves it, and its standing asks for that move. A BC's coverage is the newest
  pass, short or fail on any issue criterion tracing its current wording that its identity lets
  count, and the BC names it. An unjudged one masks nothing. A commit, or the commit a runtime
  served, counts only where the live build is read to hold it. One it does not hold, and one
  nobody could check (production unreadable, or its ancestry unanswered), do not count and say
  which on their line, so an outage reads \`not_judged\` with its reason, never \`passing\`. A
  runtime that resolves to no commit, a design revision or contract version other than the one the
  requirement's latest baseline pins, a storefront draft and a backfilled abbreviated commit never
  count, and each says why on its line. A BC traced only at an earlier wording reads \`stale\`, one
  judged only at builds the live one does not hold \`not_live\`, each with its reason (\`why\`). A
  trace left on an earlier wording is refreshed by tying the BC again from the issue's Criteria
  tab; the retired row keeps its verdicts, read back as \`retired\` beside \`criteria\` from
  \`GET /api/issues/:id/criteria\`.

### The order of the work
1. **create** \`{ title }\` writes REQ-n at revision 1, a draft; \`reason\` and \`criteria\` may come with it.
   Any member of the project may, an agent included. A create without a reason asks its author
   why, as a question on the requirement, and the answer becomes that revision's reason.
2. **revise** writes a new draft revision against the head you read: send that head as
   \`baseRevision\`, or the write is \`REQUIREMENT_REVISION_STALE\`. A revision's \`reason\` says why it
   was written; it is asked, never required. In its criteria list, a criterion naming a live code keeps
   that code (reworded under it, or unchanged), one naming no code takes the next code never used,
   and a live code you leave out is retired. A code is never reissued, which is what lets an issue's
   trace to BC-3 mean the same thing next month. Naming a code the base does not hold is
   \`CRITERION_CODE_UNKNOWN\`; naming one twice \`CRITERION_CODE_DUPLICATE\`. A \`revision_diff\`
   suggestion is held to the same rules where it is proposed, not first at its accept: a new
   criterion in it carries no code. A \`scenario\` criterion
   must read Given / When / Then, each starting a line (\`CRITERION_SCENARIO_UNPARSEABLE\`).
   What the input leaves unsettled goes in \`spec.openQuestions\` (\`{ question, whoAnswers, blocking }\`):
   each is asked as a question on the requirement and keeps its \`questionId\`, which a later revision
   sends back to keep the same question (one naming a question the requirement does not list is
   \`REQUIREMENT_OPEN_QUESTION_UNKNOWN\`). What it takes as true without proof goes in
   \`spec.assumptions\` (\`{ text, owner, confirmBy }\`). The read lists the questions standing on the
   requirement under \`questions\` (asked of it, or named as about it from an issue or a run through an
   ask's \`about\`), and \`unclear\` counts the open ones; an answer reaches it as a decision.
   **edit** rewrites a draft in place, whole: send the criteria list you read back, codes included,
   and a code the draft itself gave keeps that code, as a live code of its base does. Anything past
   draft is \`REQUIREMENT_REVISION_NOT_DRAFT\`. An open draft is **withdrawn** for good with
   \`POST …/requirements/:req/revisions/:n/withdraw { reason }\` (its author may; anyone else holds
   requirements.approve), or when a person answers "withdraw" on the steward's question about a stuck
   one; it keeps why, by whom and when, no longer counts as the open revision, and editing or proposing
   it is \`REQUIREMENT_REVISION_WITHDRAWN\`. A stuck draft requirement is asked merge, drop or keep.
3. **propose** puts the draft in front of whoever approves it. Proposing also checks the base is still the head. Every revision
   read back carries \`criteriaChanges\`: the BC codes it added, reworded and removed against the revision
   it was written against, computed from the criteria, never typed (null for a first revision).
4. Its approver (see *Who may act*) **accepts** it with \`{ reason }\`, why and on whose authority (it becomes current, the
   previous current is superseded, and the reason is kept on the revision), or **returns** it with a reason (it goes back
   to draft, and each return is kept as its own record). An accept with no reason, or a blank one, is
   \`REQUIREMENT_SIGNOFF_REASON_REQUIRED\` whoever accepts, as an agree or a re-pin without one is.
5. Its approver **agrees** the head: the requirement becomes \`agreed\` and a **baseline** is written that
   pins each linked design at its approved revision. The kernel judges the agree by the ready checklist,
   read from the head: the problem, who it is for, the value and how it is measured, the business
   criteria, no blocking open question, and a linked workflow design; its kind, out of scope and roadmap
   lane take a recommended answer when unstated. The goal answers the problem, value, measure and lane on
   lines starting \`Problem:\`, \`Value:\`, \`Measured by:\` and \`Roadmap:\`, and where no \`Problem:\` line
   states it, the unlabelled lines before the first label do, so adding a label never takes it away; a revision written in
   Vietnamese (\`writtenLang: vi\`) may label them in its own language, ${(['problem', 'value', 'measured', 'roadmap'] as const).map((l) => `\`${GOAL_LABEL_WORDS.vi[l]}:\``).join(', ')},
   and the English labels are read in either. Each blocking gap is
   refused \`CHECKLIST_INCOMPLETE\` on \`/answers/<question>\`, naming it. \`GET …/requirements/:req/checklist\`
   reads the ready and the acceptance checklists before you move: each one's form, how the head stands
   against it now (\`now\`: answers given or assumed with their source, gaps in plain words; null for
   acceptance on a draft) and the moves it judged, with the answers each was judged by. Also refused by name:
   \`REQUIREMENT_REVISION_NOT_CURRENT\` (no current head, or the head is not current),
   \`REQUIREMENT_DESIGN_UNAPPROVED\` naming every linked design with no approved revision, and
   \`REQUIREMENT_ALREADY_AGREED\`.
6. **After the agree, a change is a new revision.** Accepting it re-baselines: the requirement stays
   (or goes back to) \`agreed\`, a new baseline is written, and the accept's \`reason\` is that
   re-baseline's sign-off. The agree's design guard and ready checklist apply to it, read from the new head.
7. **repin** writes a new baseline of the same text revision once a linked design has been approved
   past what the latest baseline pins, or a linked contract has a current version it does not pin. Only an agreed requirement is re-pinned
   (\`REQUIREMENT_NOT_AGREED\`), and a re-pin with nothing moved is \`REQUIREMENT_PINS_CURRENT\`.
   Nothing re-pins by itself: a design approval only makes the re-pin due, and the requirement waits on
   it (REQ-41 BC-10).
8. **A mockup shows the screen it describes.** Propose one on the requirement at its open or current
   revision when the picture's rough sketch will not settle a screen. Once a person has tried and
   decided it, the next agree or re-pin pins each accepted one beside the designs. A re-pin is taken once a mockup is accepted after the agree. Kinds, review and revisions:
   ${guideRef('mockups')}.

### Issues against a requirement
- **link_issue** once the requirement is agreed or accepted (\`REQUIREMENT_NOT_AGREED\` before that). An
  issue serves one requirement: linking one held elsewhere is \`REQUIREMENT_ISSUE_LINKED_ELSEWHERE\`, naming
  the requirement that holds it. **unlink_issue** \`DELETE /api/projects/:id/requirements/:req/issues/:issue\`
  frees it there first.
- An issue's plan records the revision and the baseline it was written against. A plan written while
  the requirement has no current revision is refused \`REQUIREMENT_REVISION_NOT_CURRENT\`.
- \`GET /api/issues/:id\` then shows \`requirement.changedSincePlan\`: true when the head is now another
  revision whose BCs differ from the plan's in a BC one of its criteria traces (reworded or removed),
  or when its plan names no revision. A re-pin, or a revision that changed only BCs it does not
  trace, leaves it unflagged. Re-plan against the current head; do not build against a plan that reads changed. An issue that
  reads changed carries \`REQUIREMENT_CHANGED_SINCE_PLAN\` on its requirement link and in its
  run's context until its plan is rewritten; no status move refuses on it. While it reads changed and has not
  closed, the agreed requirement's standing holds a \`re-plan\` task for it in \`tasks\`, the
  project master's, one per issue and revision, with no due date.
- A plan written before the link reads changed-since-plan, unless a holder of \`requirements.approve\`
  passes \`adoptPlan: true\`, attesting the plan already satisfies the current revision
  (\`REQUIREMENT_NO_PLAN_TO_ADOPT\` when the issue has no plan).
- A breakdown accept files its issues at \`draft\`, and while every live issue is a draft the standing
  asks whoever the project's admit gate names to "promote N draft issues"; anyone
  else reads it as waiting on "a BA or owner who can admit issues" (signing does not widen who may
  admit). **promote** \`{ issues? }\` moves them \`draft → open\`: the named ones (key or uuid), or every
  linked draft when none is named. It asks what admitting an issue asks, the gate \`approval_admit\`:
  \`issues.admit\` where it is enforced, \`project.write\` where it is not; a caller without it is
  refused \`PERMISSION_FORBIDDEN\` naming it and the gate before anything moves. Each moves through its own status move, so the move's own guards
  hold (an archived issue, a gap in the issue-ready checklist). The answer is \`{ requirement, promoted, refused }\`:
  a draft whose move was refused is named in \`refused\` once per refusal, with that move's own code,
  \`path\` (\`/answers/<question>\` for a checklist gap) and words, while the rest still move; when none
  moves the act is refused with nothing written, each refusal at \`/issues/<key>\` followed by its own path. Refused whole by name:
  \`REQUIREMENT_NO_DRAFT_ISSUES\`, \`REQUIREMENT_ISSUE_NOT_LINKED\` or \`REQUIREMENT_ISSUE_NOT_DRAFT\` at
  the named issue's place in \`issues\`, \`REQUIREMENT_DEFERRED\`, and \`REQUIREMENT_NOT_AGREED\` for a
  draft or dropped requirement.
- **link_workflow** \`POST …/requirements/:req/workflows { workflowId }\` names a design the next agree or repin pins.
- **trace** ties one business criterion to the steps and edges of a design the requirement links:
  ${TRACE_ACT}. It is the only way to trace: a revision
  write and the link take no steps. The workflow approval checklist reads these traces, and refuses a
  linked design none of whose criteria is traced.
- **link_contract** \`{ contract: "<project>/<contract>" }\` names a contract this project publishes or
  consumes (\`REQUIREMENT_CONTRACT_UNKNOWN\` otherwise). The next agree or repin pins its current
  (newest approved) version; while none is approved nothing is pinned for it, and the standing waits
  on a re-pin once one is.

### The value check
Every new requirement, from every door (web, API, MCP, chat), gets one value check from the intake
assistant before anyone works it: who it is for, what improves, how that is measured, and whether it
already exists. Each answer names its source: the requirement itself, a record shown, or a
question's recommended answer. The check ends one of four ways. **accept** keeps it as a draft. **merge**
proposes a \`duplicate\` suggestion into what it repeats, which an approver decides. **alternative** says
what would serve better. **refuse** moves it from \`draft\` to \`refused\` with a one-line reason.
Only a missing problem or value, or a criterion a conflict link quotes, holds the check, as a question
with \`blocks\` set. While it holds, agreeing is refused on the checklist's questions gap. Any other gap
takes the recommended answer, named \`question:N\`. \`POST /api/projects/:id/intake-drafts/:ref/answers\` (\`:ref\` the REQ-n)
\`{ question, option }\` answers one (the author or \`project.write\`). Answering the last blocking question
drafts it again (\`intake.answered\`). \`POST …/keep\` \`{ reason }\` (one line, \`project.write\`) moves a
refused requirement back to \`draft\`. Keeping one that is not refused is \`VALUE_CHECK_NOT_REFUSED\`.

### Deferring
**defer** \`{ reason }\` takes a draft or agreed requirement out of the current release
(\`REQUIREMENT_NOT_DEFERRABLE\` from any other status, \`REQUIREMENT_DEFER_REASON_REQUIRED\` without a
reason). It is refused while a linked issue is past draft and not closed
(\`REQUIREMENT_HAS_LIVE_ISSUES\`, naming each): drop or unlink them, or leave them at draft, first. A
deferred requirement waits on nobody and is not broken down; accepting, agreeing, re-pinning and
linking an issue on it are \`REQUIREMENT_DEFERRED\`. **undefer** \`{ reason }\` puts back the status it
was deferred from, saying why it comes back (\`REQUIREMENT_UNDEFER_REASON_REQUIRED\` without one).

### Moving the delivery, accepting it, and dropping
**start-delivery** \`{ reason? }\` moves \`agreed → in_delivery\`, refused \`REQUIREMENT_NO_LIVE_ISSUE\`
while no live issue links to it. **mark-delivered** \`{ reason? }\` moves \`in_delivery → delivered\`,
refused \`REQUIREMENT_CRITERIA_UNPROVEN\` naming each live BC with no pass on the running build;
\`agreed → delivered\` is no edge (\`TRANSITION_NOT_AN_EDGE\`). Nothing moves either on its own and
no notice announces one: the standing asks for the move once every issue closed and every BC passes.
**accept** \`{ revision, reason?, byDecision? }\` names the head whose delivery is accepted, from
\`agreed\`, \`in_delivery\` or \`delivered\`: the requirement becomes \`accepted\` and \`acceptedAt\` is
stored. Refused by name: \`REQUIREMENT_REVISION_STALE\` (not the head), \`REQUIREMENT_NOT_DELIVERED\`
(from any other status), \`REQUIREMENT_ALREADY_ACCEPTED\`. The kernel judges it by the acceptance
checklist: every live issue shipped, every current BC passing on the running build, and each counted
verdict citing its evidence; a gap is refused \`CHECKLIST_INCOMPLETE\` on \`/answers/<question>\`,
naming each issue or BC. That stays the default. With \`byDecision: true\` the same signer accepts
over the gaps: a blank reason is \`REQUIREMENT_DECISION_REASON_REQUIRED\` and a linked issue neither
closed nor dropped is \`REQUIREMENT_HAS_UNFINISHED_ISSUES\`, naming it. Each waived item is recorded
as a \`waived\` answer on the move and posted as a decision comment; the requirement reads
\`acceptedByDecision\`, counts as done, leaves the duplicate check, and no read reports its BCs as
proven. A correction after it comes in as feedback; a new revision accepted re-agrees it. **drop**
\`{ reason }\` ends a draft, agreed, in-delivery or deferred requirement that is not going to
be built (\`REQUIREMENT_NOT_DROPPABLE\` once accepted, \`REQUIREMENT_DROP_REASON_REQUIRED\` without a
reason), refused while any live issue links to it (\`REQUIREMENT_HAS_LIVE_ISSUES\`, naming each).

### A capability that already shipped
A requirement agreed over a capability that already shipped owes no issue whose only work is verifying
it (REQ-45 r3 BC-8). Judge each criterion on the running build at the requirement itself instead:
**verdicts** \`{ criterion: 'BC-n', verdict, reason?, identity: { kind: 'commit', sha }, evidence }\`
(\`project.write\`), the commit the live build serves and what the verdict was taken from (a link, or a
repository path at that commit). Refused by name: \`REQUIREMENT_VERDICT_NOT_DELIVERING\` (not agreed, in
delivery or delivered), \`REQUIREMENT_VERDICT_CRITERION_UNKNOWN\` (no live wording of that code, naming
each one), \`REQUIREMENT_VERDICT_UNCITED\` (a pass, short or fail citing nothing) and the \`VERDICT_*\`
rules every verdict meets. The answer is the criterion's coverage, so you see at once whether it counts:
only where the live build holds the commit, and a short never does. Each verdict reads on its BC in the
standing's \`coverage[].verdicts\`; \`GET …/verdicts\` lists them, newest first. With no live issue and one
such verdict the requirement rests on its shipped capability and owes no breakdown: every BC passing, it
waits on its accept, which its checklist takes; a BC with no counted pass waits on the project's judge;
a BC failing waits on the master to break that BC down, the one breakdown it then owes.
A fail goes to the issues tracing the BC, and the answer's \`routed\` names each with its \`outcome\` and
\`why\`: \`reopen\` for a landed one whose own criteria tracing it do not all pass, \`building\` for one still
being built, which owns what is missing, and \`stays\` for a landed one that delivered its half, told so on
it. With none building and every landed one passing, the newest landing is sent back.

### Who may act
Anyone on the project creates, revises, edits and proposes revisions, and links designs. Accept,
return, agree, repin, defer, undefer, start-delivery, mark-delivered, accept, drop, promote, linking an issue and \`adoptPlan\` take \`requirements.approve\`,
except where the project document's person gates say no person is needed: with \`approvals.agree\`,
\`approvals.revisions\` or \`approvals.accept\` off (the default), agreeing, accepting a revision or
re-pinning (both held by \`approvals.revisions\`), or moving or accepting the delivery takes \`project.write\` and its complete checklist decides; on, it takes
\`requirements.approve\`. Promote takes what the admit gate asks instead. Under a gate profile
(\`GET /api/projects/:id/gates\`, REQ-76) each of these switches is the gate \`approval_<step>\`: strict
asks the approve permission always, standard as the switch says, yolo never. Each is held on the project (project admin, or an org owner or admin), person or agent alike, the revision's author
included; without it the call is refused \`PERMISSION_FORBIDDEN\` naming the permission. Whoever
lacks it proposes and stops; the requirement's \`waitingOn\` names whose turn it is. A change an agent
proposes without writing the revision itself is a \`revision_diff\` suggestion (${guideRef('suggestions')}),
and accepting one writes a new revision **proposed** by the accepting holder, never a current one: the
accept of that revision, which re-baselines it, is the one act it still owes.

### Contract requests from another project
\`POST /api/projects/:id/contract-requests { contract: "<provider>/<contract>", title, reason, criteria }\`,
from the requesting project \`:id\`, lands a draft requirement in the provider project that names the
requester and links the contract (the requester consumes it or the provider publishes it, else
\`REQUIREMENT_CONTRACT_UNKNOWN\`; never its own project, \`REQUIREMENT_REQUEST_OWN_PROJECT\`). Only the
provider signs it: a member of the requesting project without \`requirements.approve\` there is
refused \`REQUIREMENT_SIGNOFF_FORBIDDEN\`.

### Screen bindings
A design step's \`node.binds: [{ provider, slug, element }]\` names the contract elements a screen
uses. A baseline pinning that design pins them with it, and the detail's \`bindings\` lists each with
\`brokenBy\`, the version past the pin that removed or broke it, and \`buildingIssues\`, the issues building
that flow: those whose build link names the design and those whose live criteria trace a BC of this
requirement, dropped ones left out (empty while nothing broke it). Binding a contract that is not
element-indexed (asyncapi, protobuf, opaque) is refused \`REQUIREMENT_BINDING_NOT_INDEXED\` both when the
design is written (\`PUT\`/\`POST\` on workflows, at the bind's pointer) and when the baseline is written.`,
};
