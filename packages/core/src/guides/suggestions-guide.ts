import { BREAKDOWN_SLA_WORKING_DAYS } from '@forge/contracts/requirements';
import {
  BREAKDOWN_ISSUE_DEFAULTS,
  SUGGESTION_MAX_OPEN_PER_TARGET,
  SUGGESTION_PURGE_PAYLOAD_AFTER_DAYS,
  SUGGESTION_STALE_AFTER_DAYS,
} from '@forge/contracts/suggestions';
import { guideRef } from './guide-ref.js';
import type { CoreGuide } from './types.js';

export const SUGGESTIONS_GUIDE: CoreGuide = {
  slug: 'suggestions',
  audience: 'agent',
  title: 'Suggestions: propose, and let a person decide',
  summary:
    'What an agent writes instead of changing a requirement, an issue or a feedback item it may not decide: the seven kinds and their targets, the base revision a suggestion is checked against twice, the open-queue cap, who accepts, and what accepting each kind writes.',
  version: 1,
  body: `## Suggestions: propose, and let a person decide

A suggestion is a proposed change that waits on a person instead of changing anything. An agent, the
BA assistant or a person writes one; a person of the project accepts or rejects it; its
effect is written in the accept's own transaction and points back at it. The door is
\`/api/projects/:id/suggestions\` (\`POST\` writes, \`GET\` lists) and
\`…/suggestions/:sid/accept|reject|revise|withdraw\`.

### The kinds, and what each targets
| Kind | Target | Accepting it writes |
|---|---|---|
| \`revision_diff\` | a requirement | a new **draft** revision on that requirement, authored by the producer; never a current one, so the requirement's own propose and accept still follow |
| \`requirement_draft\` | an issue | a new requirement at revision 1, a draft |
| \`readiness\` | a requirement | the readiness result at its base revision, which an agree reads when the project gates on readiness |
| \`breakdown\` | a requirement | every proposed issue, filed at **draft** with its complexity, priority and category, linked to the requirement, traced to its BCs, edged by \`blockedBy\` and linked as the build of the pinned design it builds, in one transaction; nothing dispatches until a person promotes them, and the build gate holds each until its design is approved |
| \`triage\` | an issue | the issue's priority, category and complexity; a free-text \`route\` is kept as a note comment on the issue |
| \`duplicate\` | an issue or a requirement | on an issue, drops it naming the root, with a relates edge to it; on a requirement it is refused \`SUGGESTION_EFFECT_UNDECIDED\`, because no effect is defined for it |
| \`feedback_triage\` | a feedback item | the route on the item (${guideRef('feedback-triage')}) |

A payload that does not parse for its kind is \`SUGGESTION_PAYLOAD_INVALID\`, naming the path; a target
the kind does not take is \`SUGGESTION_TARGET_INVALID\`.

### The base revision is checked twice
- On a requirement, \`baseRevision\` is the head you read; on an issue or a feedback item, and on a
  requirement with no current revision yet, it is \`null\`.
- It is compared with the head **when the suggestion is written and again when it is accepted**. A moved
  head is \`SUGGESTION_BASE_STALE\`, naming both revisions. At accept the row is also marked \`stale\`.
- Every proposed suggestion on a requirement goes \`stale\` the moment a newer revision of it is
  accepted, and accepting one \`revision_diff\` stales the other proposed suggestions on that
  requirement. Read the head again and propose against it; never re-send a stale payload unchanged.

### Before you write one
- An open suggestion of the same kind proposing the same change on the same target is
  \`SUGGESTION_DUPLICATE\`, naming it: the comparison ignores key order.
- At most ${SUGGESTION_MAX_OPEN_PER_TARGET} proposed suggestions wait on one target; another is
  \`SUGGESTION_QUEUE_FULL\` until a person decides one.
- A \`breakdown\` is the project master's to propose (workflow requirement-to-delivery step
  \`breakdown\`): only the project's own agent writes one, and a person, the BA assistant or another
  project's agent is \`SUGGESTION_BREAKDOWN_PROPOSE_FORBIDDEN\`, a reviewer's revise included (reject it
  with a reason and the master proposes again). A requirement revision holds one open breakdown; a
  second is \`SUGGESTION_BREAKDOWN_OPEN\`. Every issue carries at least one criterion and every
  criterion names the BC it traces to (\`tracesTo\`). The master owes it within
  ${BREAKDOWN_SLA_WORKING_DAYS} working days of the agree; the requirement's standing serves the task
  with its due time.
- A \`breakdown\` is checked at write and at accept: a \`tracesTo\` naming a BC the base revision lacks, a
  \`blockedBy\` index outside the breakdown or a cycle among them is \`SUGGESTION_PAYLOAD_INVALID\`; a
  string \`blockedBy\` names an existing issue of this project by key or uuid, and one that resolves to
  nothing here is \`SUGGESTION_BLOCKER_UNKNOWN\`, a closed, dropped or archived one
  \`SUGGESTION_BLOCKER_TERMINAL\`.
- Each breakdown issue carries \`complexity\` (\`xs\` to \`xl\`): an empty one would pick the heaviest run
  rung, so a missing one is \`SUGGESTION_PAYLOAD_INVALID\` at its path. \`priority\` defaults to
  \`${BREAKDOWN_ISSUE_DEFAULTS.priority}\` and \`category\` to \`${BREAKDOWN_ISSUE_DEFAULTS.category}\`; the accept's effect names, per
  issue, what was written and which fields took the default.
- \`builds\` names the design the issue builds, one the requirement's latest baseline pins (\`null\`:
  none). Left out, the one pinned design is taken and none links nothing; with several pinned it is
  \`SUGGESTION_BUILD_UNNAMED\`, and a flow the baseline does not pin \`SUGGESTION_BUILD_UNPINNED\`.

### Deciding
- **accept** \`{ suggestionId, reason? }\` and **reject** \`{ suggestionId, reason }\` take
  \`suggestions.approve\` on the project (project admin, or an org owner or admin), person or agent alike,
  its producer included; without it the call is refused \`APPROVE_PERMISSION_REQUIRED\`. An accept's reason is kept on the suggestion and is where the authority
  behind it is named. A rejection must say why (\`SUGGESTION_REJECT_REASON_REQUIRED\`), and that reason
  is what keeps the next suggestion on the target from repeating it.
- **revise** \`{ suggestionId, payload, reason }\` is a reviewer's edit. The original is rejected with
  the reason, and a new suggestion carrying the whole new payload is proposed by the reviewer in the
  same write, naming the original in \`revises\`; every check a new suggestion takes applies to it.
  Revising rejects the original, so it takes \`suggestions.approve\` like any decision
  (\`APPROVE_PERMISSION_REQUIRED\`), and a payload that changes nothing is
  \`SUGGESTION_REVISION_UNCHANGED\`.
- **withdraw** is the producer retracting its own (\`SUGGESTION_WITHDRAW_FORBIDDEN\` for anybody else,
  who rejects or revises it instead).
- A decided suggestion stays decided: accepting, rejecting or withdrawing it again is
  \`SUGGESTION_DECIDED\`.
- A suggestion nobody decides within ${SUGGESTION_STALE_AFTER_DAYS} days goes \`stale\`; a rejected,
  stale or withdrawn one loses its payload ${SUGGESTION_PURGE_PAYLOAD_AFTER_DAYS} days after the
  decision.

### Reading them
\`list\` takes \`{ requirement | issue, status? }\` and answers summaries without payloads; ask for
\`view: 'full'\` when you need what a suggestion proposed. Statuses: \`proposed\` (waits on a person),
\`accepted\`, \`rejected\`, \`stale\`, \`withdrawn\`. Requirement revisions themselves are in
${guideRef('requirement-lifecycle')}.`,
};
