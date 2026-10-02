// The ecosystem tier of the capability-guide registry: how a master works what its project's
// channel owes. Same shape, same consumers as registry.ts.
//
// Altitude (NT1): the order of the work and what refuses it. Each tool carries its own schema.

import type { ForgeGuide } from './types.js';

export const ECOSYSTEM_INBOX_GUIDE: ForgeGuide = {
  slug: 'ecosystem-inbox',
  audience: 'agent',
  title: "Working a project's ecosystem inbox",
  summary:
    'What a channel document or an open builder run owes a master, how the box tells it, and the order to read, reply, submit, map the links this project uses and keep them true — on /mcp, with the author taken from the token.',
  version: 2,
  body: `## Working a project's ecosystem inbox

A project in an ecosystem is written to by the projects it shares that ecosystem with: a change notice
about a contract it consumes, a request for information, a change request. A document that owes a
reply is work for the project's master exactly as an open issue is, and it is worked on \`/mcp\` with
\`forge_channel\` and \`forge_ecosystem\`.

### How it reaches you
- Your box reads what the channel owes this project on every sweep, from core's
  \`GET /api/devices/me/channel/unanswered\`. A \`master.wake\` with \`source: 'channel'\` only makes
  that sweep come sooner; a wake that was lost loses nothing, because the inbox is read, not the wake.
- When anything is owed, the pass is nudged even when the backlog is empty, and the nudge names how
  many documents are waiting. A pass that ends with the inbox untouched and no word on why is the same
  deviation as an idle pane with admissible issues.

### What counts as owed
\`forge_channel action=unanswered\` lists exactly what the sweep counted. A document is on it when it is
published to this project, its type owes a reply (a binding change notice owes an acknowledgement; an
RFI and a change request owe a decision), no published reply from this project answers it yet, no
person holds its thread, and no reply of yours is already waiting at the approve gate. A non-binding
change notice owes nothing and is not listed; read it in \`inbox\` when the pass has room.

### The order of the work
1. \`unanswered\`, then \`read\` each number and \`thread\` the conversation it opened. Read
   \`contracts\` for the provider's API page when the document is about a contract.
2. Decide. When the answer needs work in this repository, that work is an issue like any other; the
   reply says what this project decided, and never prescribes the counterparty's implementation.
3. \`reply\` with \`inReplyTo\` and the type the parent owes: it is a draft. \`submit\` it. A project whose
   channel gates its documents holds the submit for an admin: the document leaves \`unanswered\` while
   it waits, and comes back if the admin returns it — then \`edit\` it as the note asks and \`submit\`
   again.
4. If a change notice moves a contract this project consumes, keep the link true:
   \`forge_ecosystem action=links\`, then \`link_update\` with the \`baseRevision\` you read. A link is
   written only by the consuming project's own agent; any other credential is refused
   \`LINK_WRITER_NOT_CONSUMER\`, and a person never writes one.

### Working a builder run
Joining an ecosystem opens a builder run for the joining project (trigger \`joined\`), and a push to its
default branch opens another (trigger \`push\`, at the pushed commit) once the last one is finished.
A git project's joined run names its default branch's head as its host reports it; where that head
cannot be read the join is refused \`BUILDER_RUN_HEAD_UNREADABLE\` and nothing opens. A storefront
project has no commit, so its trigger is \`{ sha: null, source: "storefront" }\`.
Links go out from the project: the run maps what THIS project's own code uses, never what others use
of it. Where that code lives is the project document's \`source.type\`, and it decides the run's steps
when the run opens; a run already open keeps the steps it was opened with.
The box sees an open run in the same sweep (\`builderRuns\` beside the channel's \`items\`), and a
\`master.wake\` with \`source: 'ecosystem_build'\` only makes that sweep come sooner.

1. \`forge_ecosystem action=builder_runs\`, then \`builder_run\` the open one. A git project's steps are
   \`read-repo\`, \`find-outbound-calls\`, \`match-contracts\`, \`write-links\`, \`check\`,
   \`publish-role\`; a storefront project's (\`source.type: storefront\`, no repository) are
   \`read-storefront\`, \`find-provider-usage\`, \`match-contracts\`, \`write-links\`, \`check\`,
   \`publish-role\`. Each starts \`pending\`. Move one to \`running\` before you start it and to
   \`succeeded\`, \`failed\` or \`skipped\` (with a \`detail\`) when it ends, by \`builder_run_update\`
   with the \`baseRevision\` you read. A status outside those five is refused \`STEP_STATUS_UNKNOWN\`;
   \`superseded\` is the supersede verb's alone, and a write naming it is refused.
2. Read the code where it lives and find every outbound use: a git project reads its repository at
   HEAD; a storefront project reads what its provider holds (on \`autoflow\`, its workflows, routes and
   nodes). Record each as a finding: \`matched\` (to a contract an active member publishes here, else
   \`REF_NOT_PUBLISHED\`), \`outside_ecosystem\` with its host, or \`unknown\` with a note.
3. For each matched use, \`link_create\` (or \`link_update\`) the link from the module that calls it,
   with its call sites, and name the link's id in the run's \`links\`. A call site is the shape the
   project's source holds, and the other shape is refused \`CALL_SITE_KIND_MISMATCH\`:
   - git: \`{ path, line, operation }\`, the path relative to the checkout (else \`PATH_OUTSIDE_REPO\`);
   - storefront: \`{ artefact: { kind, id }, operation }\`, the kind one its provider holds (on
     \`autoflow\`: \`workflow\`, \`route\` or \`node\`; else \`ARTEFACT_KIND_UNKNOWN\`) and the id the
     provider's own. A finding's \`site\` follows the same rule.
4. Finish every step. The answer to the write that finishes the run carries
   \`report.declaredWithoutCallSite\`: each consumption the interface declares in this ecosystem that no
   link of yours calls. Either write the link the code uses or take the consumption out of the
   interface — it is never left standing silently.

A project works one run per ecosystem at a time: opening another while one is open is refused
\`BUILDER_RUN_ALREADY_OPEN\`; update the open one instead. Only this project's own agent writes its
runs; a person, a viewer or another project's master is refused \`BUILDER_RUN_WRITER_NOT_PROJECT\`.

A run whose steps no longer match its project's source type (the bus shows it \`stepsStale: true\`),
or one that can never finish truly, is replaced, not worked: \`forge_ecosystem
action=builder_run_supersede { run, reason }\` (REST \`POST
/api/ecosystems/:id/builder-runs/:runId/supersede { reason }\`). It closes the open run (its unfinished
steps \`superseded\`, the run naming \`supersededBy { run, reason }\`) and opens a fresh one, trigger
\`manual\`, with the steps the current source type derives, and wakes this project's master. It is
the project's own master's, or an org admin's of the steward or of the project's org; anyone else is
refused \`BUILDER_RUN_SUPERSEDE_NOT_AUTHORISED\`, a run already finished \`BUILDER_RUN_NOT_OPEN\`, no
reason \`BUILDER_RUN_SUPERSEDE_WITHOUT_REASON\`. A superseded run is closed: a write to it is refused
\`BUILDER_RUN_SUPERSEDED\`.

### Rules
1. **The author is the token.** An agent token writes \`via: master\`, a personal token \`via: cli\`, a
   chat turn \`via: assistant\`. No argument names the author: an \`author\`, \`authoredBy\` or \`from\`
   key is refused \`CHANNEL_ARGUMENT_INVALID\` and nothing is written.
2. **Name the side.** On \`/mcp\` the project is \`projectId\`, the token's own bound project, or the
   \`X-Forge-Project-Slug\` header. Naming none is refused \`CHANNEL_PROJECT_UNNAMED\`; naming one the
   token does not reach is refused \`CHANNEL_PROJECT_OUTSIDE_TOKEN\`.
3. **A held thread is a person's.** \`THREAD_HELD\` means stop; it returns to \`unanswered\` when they
   release it. Never release a hold to get your reply through.
4. **A refusal is the answer.** Each comes back as \`{ code, path, detail }\` under the rule's own
   code; read the detail and fix the document. Do not retry the same shape.`,
};
