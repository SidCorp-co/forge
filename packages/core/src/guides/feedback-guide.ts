import { guideRef } from './guide-ref.js';
import type { CoreGuide } from './types.js';

export const FEEDBACK_TRIAGE_GUIDE: CoreGuide = {
  slug: 'feedback-triage',
  audience: 'agent',
  title: 'Feedback: filing, triage, resolution and verification',
  summary:
    'How a product feedback item (FB-n) is filed about one target, why its planned and resolved phases are read from the work it was routed to, how an agent proposes a route a holder of feedback.approve accepts, the one clarification question, duplicates, decline, verify and reopen, and what a sensitive project withholds.',
  version: 1,
  body: `## Feedback: filing, triage, resolution and verification

A feedback item (FB-n) is what a reporter says is wrong or wanted in the product. The door is
\`/api/projects/:id/feedback\`: \`POST\` files one (\`create\` below) and \`GET\` lists them,
\`GET …/feedback/:fb\` reads one, and each act below is \`POST …/feedback/:fb/<act>\` (\`triage\`,
\`route\`, \`verify\`, \`reopen\`, \`clarification\`). It is not an agent report,
an agent's report about its own run: \`POST …/feedback/promote\` turns one of this project's reports
into FB-n when it is product feedback after all.

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

### Triage: decided by a holder of feedback.approve, the case writes the route
- Triage picks one of \`issue\`, \`revision\`, \`new_requirement\`, \`answer\`, \`duplicate\` or \`decline\`,
  by the rule table (workflow requirement-to-delivery step \`triage\`): a bug routes to an issue, a
  contract change to the consumer's upgrade issue, a question to an answer, a change request or an idea to
  a revision of the agreed requirement it is about or else to a new requirement, and any kind to
  duplicate or decline. A route outside the item's kind is \`FEEDBACK_ROUTE_KIND_MISMATCH\` (change its
  \`kind\` in the same triage if it was filed as the wrong one); a revision for an item about no agreed
  requirement, a suggestion that is not a revision_diff of that requirement, or a new-requirement route
  carried by a requirement that is not a draft is \`FEEDBACK_ROUTE_TARGET_MISMATCH\`.
- **Triage opens the item's case** (step \`fb-case\`), one per item: owned by the project master for an
  issue route and by the BA otherwise, due by severity (critical 1, high 2, medium 5, low 10 working
  days), and for a contract change at the end of the provider's commitment window. The item reads
  \`triaged\` and waits on the case's owner by name until the route is written.
- What carries the route may come with the triage, and is then written at once: \`issue\` (\`issue\` to
  link one, or \`createIssue\` to file a draft, which takes the requirement of the item's target, or of
  its target issue), \`revision\` (\`suggestion\`), \`new_requirement\` (\`requirement\`, a draft, or
  \`title\` to start one) and \`answer\` (the text the reporter reads). Otherwise the owner writes it
  later with \`POST …/feedback/:fb/route\`, whose body is that carrier alone, with the same
  permission as triage, and only while the case waits (\`FEEDBACK_CASE_NOT_OPEN\`). A carrier of another route is
  \`FEEDBACK_ROUTE_TARGET_MISMATCH\`, two alternatives at once or a write naming none
  \`FEEDBACK_ROUTE_INCOMPLETE\`.
- **duplicate** names its root in the triage (\`duplicateOf\`): a root that is not itself a duplicate, and
  an item others point at stays a root (\`FEEDBACK_DUPLICATE_CHAIN\` names the root to use instead); an
  item is never its own duplicate (\`FEEDBACK_DUPLICATE_SELF\`).
- **decline** is a triage route whose reason, in \`note\`, the reporter reads
  (\`FEEDBACK_DECLINE_REASON_REQUIRED\`); it moves the item to \`declined\` and closes its case.
- **Triage is an approval.** Triage and writing a case's route take \`feedback.approve\` on the project
  (project admin, or an org owner or admin), person or agent alike; without it the call is refused
  \`PERMISSION_FORBIDDEN\` naming the permission. Without it, send \`POST /api/projects/:id/suggestions\`
  \`{ kind: 'feedback_triage', feedback, payload }\`, which writes a \`feedback_triage\` suggestion stamped by core with the nearest
  item (\`dedup\`, or why dedup did not run); a holder accepts it (\`POST /api/projects/:id/suggestions/:sid/accept\`), and the
  accept is the triage (${guideRef('suggestions')}).
- Triage is picked while the item is \`new\`, \`reopened\`, or \`triaged\` with nothing carrying it; any
  other phase is \`FEEDBACK_STATUS_INVALID\`.

### Asking the reporter
\`clarification\` \`{ prompt, needed }\` asks the reporter one question, before the item is routed
(\`FEEDBACK_CLARIFICATION_CLOSED\` once it is past \`new\` or \`reopened\`), and at most one is open per item
(\`FEEDBACK_CLARIFICATION_ALREADY_OPEN\`): wait for its answer. The answer never edits the item. Picking a
route, declining included, closes the open question.

### After it ships
- \`verify\` follows \`resolved\` and nothing else (\`FEEDBACK_NOT_RESOLVED\`): an item is never verified
  before its fix shipped, and never automatically. It takes \`feedback.approve\`
  (\`PERMISSION_FORBIDDEN\` without it).
- \`reopen\` \`{ reason }\` also follows \`resolved\`, says what the fix does not answer
  (\`FEEDBACK_REOPEN_REASON_REQUIRED\`), and sends the item back to triage.
- Every triage, route write, decline, verify, reopen, redaction and promotion is kept as its own decision record, so
  a re-triage keeps the history.

### Sensitive projects
On a project whose data policy is \`redact\` or \`no_egress\`, the title, body, where-seen text, answer and
every decision reason are scrubbed on write. On a \`no_egress\` project every answer of this door carries
metadata only, and a text search (\`q\`) is \`FEEDBACK_SEARCH_WITHHELD\`: list by phase instead.
\`DELETE …/feedback/:fb/reporter-data\` deletes an item's text, attachments and embedding while keeping the row; it takes
\`feedback.redact\` (project admin), which a token holds only where its own grant names it
(\`PERMISSION_FORBIDDEN\` without it).

### Reading the list
\`GET …/feedback\` \`?phase=&q=&requirement=\` answers each item's derived phase and who it waits on: a person to
triage a new or reopened item, the case's owner (BA or Project master) to write a triaged one's route, the carrier to ship a planned one, the reporter to verify a resolved one.
\`GET …/feedback/:fb/similar\` compares stored embeddings to find likely duplicates. How a requirement a
feedback item revises moves is in ${guideRef('requirement-lifecycle')}.`,
};
