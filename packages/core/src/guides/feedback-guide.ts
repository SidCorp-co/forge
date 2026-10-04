import { guideRef } from './guide-ref.js';
import type { CoreGuide } from './types.js';

export const FEEDBACK_TRIAGE_GUIDE: CoreGuide = {
  slug: 'feedback-triage',
  audience: 'agent',
  title: 'Feedback: filing, triage, resolution and verification',
  summary:
    'How a product feedback item (FB-n) is filed about one target, why its planned and resolved phases are read from the work it was routed to, how an agent proposes a route a person accepts, the one clarification question, duplicates, decline, verify and reopen, and what a sensitive project withholds.',
  version: 1,
  body: `## Feedback: filing, triage, resolution and verification

A feedback item (FB-n) is what a reporter says is wrong or wanted in the product. \`forge_feedback_items\` is
the door, and the REST routes under \`/api/projects/:id/feedback\` are the same services. It is not
\`forge_feedback\`, which is the old name of the agent-report tool: an agent's report about its own run
is a different thing, and \`promote\` turns one of this project's reports into FB-n when it is product
feedback after all.

### Filing
- \`create\` takes a \`kind\` (\`bug\`, \`change_request\`, \`question\`, \`idea\`, \`contract_change\`), a
  \`title\`, and **exactly one** target: a \`requirement\`, \`issue\`, \`release\` or \`workflow\` of this
  project by reference, or a \`screen\` named in words. Two targets is \`FEEDBACK_TARGET_NOT_ONE\`; a
  reference that resolves to nothing is \`FEEDBACK_TARGET_UNKNOWN\`, one in another project
  \`FEEDBACK_TARGET_NOT_IN_PROJECT\`.
- \`promote\` \`{ agentReport, kind, … }\` copies a report's summary and detail into a new item once:
  a second promotion is \`FEEDBACK_SOURCE_ALREADY_PROMOTED\`, another project's report
  \`FEEDBACK_SOURCE_NOT_IN_PROJECT\`, a report already curated into an issue
  \`FEEDBACK_SOURCE_ROUTED_ELSEWHERE\`.

### Stored status against the phase you read
Each stored status is a person's decision: \`new\`, \`triaged\`, \`reopened\`, \`verified\`, \`declined\`.
Two more phases are **read, never written**, from the work the item was routed to:
- \`planned\`: the route's carrier is alive and has not shipped (the linked issue is open, the
  revision proposal is proposed or accepted but not delivered, the new requirement is not delivered,
  the root of a duplicate is unresolved). An agreed requirement keeps the item planned: agreeing only
  plans the work.
- \`resolved\`: the linked issue is closed, the accepted revision is delivered, the routed requirement
  is delivered, or the answer was posted. A duplicate is resolved with its root, and declined with it.
- A route whose carrier died (the issue dropped, the suggestion rejected, the requirement dropped) reads
  \`triaged\` again, and waits on a person to route it anew.

Nothing ever reads an item as \`verified\` on its own.

### Triage: an agent proposes, a person routes
- A route is one of \`issue\` (\`issue\` to link one, or \`createIssue\` to file a draft), \`revision\`
  (\`suggestion\`, a \`revision_diff\` suggestion of the target's own requirement), \`new_requirement\`
  (\`requirement\`, an existing draft, or \`title\` to start one), \`answer\` (the text the reporter reads)
  and \`duplicate\` (\`duplicateOf\`, the root). A route missing its carrier is
  \`FEEDBACK_ROUTE_INCOMPLETE\` (\`FEEDBACK_ANSWER_MISSING\` for an empty answer); one that does not fit
  the item is \`FEEDBACK_ROUTE_TARGET_MISMATCH\`: contract-change feedback goes to an issue only, a
  revision is a revision_diff of the item's own requirement, and a new-requirement route is carried by a
  draft (an agreed requirement's change is routed as a revision).
- **Routing is an approval.** Routing directly, declining and marking a duplicate take
  \`feedback.approve\` on the project (project admin, or an org owner or admin), person or agent alike;
  without it the call is refused \`APPROVE_PERMISSION_REQUIRED\` naming the permission. Without it, send
  \`propose_triage\` \`{ feedback, triage }\`, which writes a \`feedback_triage\` suggestion a holder accepts
  (\`forge_suggestions accept\`), and the accept writes the route (${guideRef('suggestions')}).
- A route is picked while the item is \`new\`, \`reopened\`, or \`triaged\` with a dead carrier; any other
  phase is \`FEEDBACK_STATUS_INVALID\`.
- **duplicate** names a root that is not itself a duplicate, and an item others point at stays a root
  (\`FEEDBACK_DUPLICATE_CHAIN\` names the root to use instead); an item is never its own duplicate
  (\`FEEDBACK_DUPLICATE_SELF\`).
- **decline** \`{ reason }\` from \`new\`, \`triaged\` or \`reopened\`; the reporter reads the reason
  (\`FEEDBACK_DECLINE_REASON_REQUIRED\`).

### Asking the reporter
\`clarify\` \`{ prompt, needed }\` asks the reporter one question, before the item is routed
(\`FEEDBACK_CLARIFICATION_CLOSED\` once it is past \`new\` or \`reopened\`), and at most one is open per item
(\`FEEDBACK_CLARIFICATION_ALREADY_OPEN\`): wait for its answer. The answer never edits the item. Picking a
route or declining closes the open question.

### After it ships
- \`verify\` follows \`resolved\` and nothing else (\`FEEDBACK_NOT_RESOLVED\`): an item is never verified
  before its fix shipped, and never automatically. It takes \`feedback.approve\`
  (\`APPROVE_PERMISSION_REQUIRED\` without it).
- \`reopen\` \`{ reason }\` also follows \`resolved\`, says what the fix does not answer
  (\`FEEDBACK_REOPEN_REASON_REQUIRED\`), and sends the item back to triage.
- Every triage, decline, verify, reopen, redaction and promotion is kept as its own decision record, so
  a re-triage keeps the history.

### Sensitive projects
On a project whose data policy is \`redact\` or \`no_egress\`, the title, body, where-seen text, answer and
every decision reason are scrubbed on write. On a \`no_egress\` project every answer of this door carries
metadata only, and a text search (\`q\`) is \`FEEDBACK_SEARCH_WITHHELD\`: list by phase instead.
\`delete_reporter_data\` deletes an item's text, attachments and embedding while keeping the row; it is a
project admin person's act (\`FEEDBACK_REDACT_FORBIDDEN\`).

### Reading the list
\`list\` \`{ phase?, q?, requirement? }\` answers each item's derived phase and who it waits on: a person to
triage a new or reopened item, the carrier to ship a planned one, the reporter to verify a resolved one.
\`similar\` \`{ feedback }\` compares stored embeddings to find likely duplicates. How a requirement a
feedback item revises moves is in ${guideRef('requirement-lifecycle')}.`,
};
