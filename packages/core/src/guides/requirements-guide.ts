import { guideRef } from './guide-ref.js';
import type { CoreGuide } from './types.js';

export const REQUIREMENT_LIFECYCLE_GUIDE: CoreGuide = {
  slug: 'requirement-lifecycle',
  audience: 'agent',
  title: 'Requirements: revisions, agreement, baselines and delivery',
  summary:
    'How a requirement (REQ-n) is written in immutable revisions with stable business criteria (BC-n), proposed, accepted and agreed by a person under a baseline pinning its designs, re-pinned, deferred, and read as delivered; and why an issue planned against it reads changed-since-plan.',
  version: 1,
  body: `## Requirements: revisions, agreement, baselines and delivery

A requirement (REQ-n) is the business intent a set of issues delivers. Its text never changes in place:
it lives in numbered revisions, and each revision carries business criteria under stable codes
(BC-1, BC-2, …) that issues trace their own criteria to. \`forge_requirements\` is the door; the REST
routes under \`/api/projects/:id/requirements\` are the same services.

### Three things move, and they are not one field
- **The requirement's status**: \`draft\` (being written; nothing is built against it), \`agreed\` (a
  person signed a revision off under a baseline), \`deferred\` (out of the current release),
  \`accepted\` (delivered and accepted) and \`dropped\` (no longer wanted). Nothing an agent sends moves
  a requirement to \`accepted\` or \`dropped\`.
- **Each revision's state**: \`draft → proposed → current → superseded\`. \`current\` is the head, the
  revision that was accepted. A requirement holds **one open revision at a time** (a draft or a
  proposed one): writing a second is \`REQUIREMENT_REVISION_OPEN\`.
- **The delivery phase**, read and never written: an agreed requirement reads \`agreed\` until a
  linked issue starts, then \`in_delivery\`, and \`delivered\` only when every live linked issue is
  closed **and** every current BC is covered by a passing verdict. A closed set with one unproven BC
  still reads \`in_delivery\`; the fix is a verdict, not a status move.

### The order of the work
1. **create** \`{ title, reason, criteria }\` writes REQ-n at revision 1, a draft. Any member of the
   project may, an agent included.
2. **revise** writes a new draft revision against the head you read: send that head as
   \`baseRevision\`, or the write is \`REQUIREMENT_REVISION_STALE\`. Every revision says why it was
   written (\`REVISION_REASON_REQUIRED\`). In its criteria list, a criterion naming a live code keeps
   that code (reworded under it, or unchanged), one naming no code takes the next code never used,
   and a live code you leave out is retired. A code is never reissued, which is what lets an issue's
   trace to BC-3 mean the same thing next month. Naming a code the base does not hold is
   \`CRITERION_CODE_UNKNOWN\`; naming one twice \`CRITERION_CODE_DUPLICATE\`. A \`scenario\` criterion
   must read Given / When / Then, each starting a line (\`CRITERION_SCENARIO_UNPARSEABLE\`).
   **edit** rewrites a draft in place, whole: send the criteria list you read back, codes included,
   and a code the draft itself gave keeps that code, as a live code of its base does. Anything past
   draft is \`REQUIREMENT_REVISION_NOT_DRAFT\`.
3. **propose** puts the draft in front of a person. Proposing also checks the base is still the head.
4. A person **accepts** it (it becomes current, the previous current is superseded) or **returns** it
   with a reason (it goes back to draft, and each return is kept as its own record).
5. A person **agrees** the head: the requirement becomes \`agreed\` and a **baseline** is written that
   pins each linked design at its approved revision. Refused by name: \`REQUIREMENT_REVISION_NOT_CURRENT\`
   (no current head, or the head is not current), \`REQUIREMENT_DESIGN_UNAPPROVED\` naming every linked
   design with no approved revision, \`REQUIREMENT_ALREADY_AGREED\`. When the project document sets
   \`requirements.readinessGate\` to \`block\`, the agree also needs an accepted readiness suggestion at
   the head with every check passing (\`REQUIREMENT_NOT_READY\`); at \`warn\` the baseline records the
   readiness result without refusing.
6. **After the agree, a change is a new revision.** Accepting it re-baselines: the requirement stays
   (or goes back to) \`agreed\`, a new baseline is written, and the accept's \`reason\` is that
   re-baseline's sign-off. The agree's design guards apply to it.
7. **repin** writes a new baseline of the same text revision once a linked design has been approved
   past what the latest baseline pins, or a linked contract has a current version it does not pin. Only an agreed requirement is re-pinned
   (\`REQUIREMENT_NOT_AGREED\`), and a re-pin with nothing moved is \`REQUIREMENT_PINS_CURRENT\`.

### Issues against a requirement
- **link_issue** once the requirement is agreed or accepted (\`REQUIREMENT_NOT_AGREED\` before that). An
  issue serves one requirement: linking one held elsewhere is \`REQUIREMENT_ISSUE_LINKED_ELSEWHERE\`.
- An issue's plan records the revision and the baseline it was written against. A plan written while
  the requirement has no current revision is refused \`REQUIREMENT_REVISION_NOT_CURRENT\`.
- \`forge_issues get\` then shows \`requirement.changedSincePlan\`: true when the head is now another
  revision, or when the head was re-pinned onto newly approved designs or contracts after the plan.
  Re-plan against the current head; do not build against a plan that reads changed. An issue that
  reads changed is refused \`awaiting_release\` (and a close from \`in_progress\`) as
  \`REQUIREMENT_CHANGED_SINCE_PLAN\` until its plan is rewritten.
- A plan written before the link reads changed-since-plan, unless a **person** passes
  \`adoptPlan: true\`, attesting the plan already satisfies the current revision
  (\`REQUIREMENT_NO_PLAN_TO_ADOPT\` when the issue has no plan).
- **link_workflow** names a design the next agree or repin pins.
- **link_contract** \`{ contract: "<project>/<contract>" }\` names a contract this project publishes or
  consumes (\`REQUIREMENT_CONTRACT_UNKNOWN\` otherwise). The next agree or repin pins its current
  (newest approved) version; while none is approved nothing is pinned for it, and the standing waits
  on a re-pin once one is.

### Deferring
**defer** \`{ reason }\` takes a draft or agreed requirement out of the current release
(\`REQUIREMENT_NOT_DEFERRABLE\` from any other status, \`REQUIREMENT_DEFER_REASON_REQUIRED\` without a
reason). It is refused while a linked issue is past draft and not closed
(\`REQUIREMENT_HAS_LIVE_ISSUES\`, naming each): drop or unlink them, or leave them at draft, first. A
deferred requirement waits on nobody and is not broken down; accepting, agreeing, re-pinning and
linking an issue on it are \`REQUIREMENT_DEFERRED\`. **undefer** puts back the status it was deferred
from.

### Who may act
Anyone on the project creates, revises, edits and proposes revisions, and links designs. Accept,
return, agree, repin, defer, undefer, linking an issue and \`adoptPlan\` take \`requirements.approve\`
on the project (project admin, or an org owner or admin), person or agent alike, the revision's author
included; without it the call is refused \`PERMISSION_FORBIDDEN\` naming the permission. Whoever
lacks it proposes and stops; the requirement's \`waitingOn\` names whose turn it is. A change an agent
proposes without writing the revision itself is a \`revision_diff\` suggestion (${guideRef('suggestions')}),
and accepting one writes a new **draft** revision, never a current one.`,
};
