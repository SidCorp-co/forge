import type { CoreGuide } from './types.js';

export const WHAT_IS_AN_ISSUE_GUIDE: CoreGuide = {
  slug: 'what-is-an-issue',
  audience: 'agent',
  title: 'What is an issue?',
  summary:
    'The four gates a thing must pass to be an issue at all, where a note / question / audit finding goes instead, and the three-way routing that stops a residual becoming an unowned draft.',
  version: 2,
  body: `## What is an issue?

An issue is a unit of **work** — not a note, not a question, not a record of something already done.

> An issue is a unit of work with a named deliverable and an owner, whose completion someone other than the author can verify.

### The four gates — file it only if it passes all four

| # | Gate | Ask | If it fails |
|---|---|---|---|
| 1 | **Deliverable** | When this is done, what *thing* exists? A diff, a merged branch, a changed config, a deleted file. | If "done" produces only TEXT — an answer, a note, a record — it is not an issue |
| 2 | **Executable** | Can whoever picks it up finish it with what the description says? | If step one is "someone must decide X", the decision is the blocker and the issue does not exist yet |
| 3 | **Verifiable exit** | Can a second person tell done from not-done by observing behaviour? | Clarify it first |
| 4 | **Owner + due signal** | Who will look at it, and what makes it speak up if forgotten? | No owner and no aging signal means filing it BURIES it |

Gate 4 is the one that gets skipped. \`draft\` means *not yet time to work on this* — never *not sure this is work*. A \`draft\` nobody owns and nothing ages is a write-only queue.

### Where it goes instead

| You have | It is | Put it |
|---|---|---|
| A session log or summary of what you did | a record | a handoff doc, or project memory |
| A note, learning, or convention | knowledge | \`POST /api/memory\` (durable business logic → repo \`docs/\`) |
| An open question needing a human decision | a decision | a comment on the issue that raised it + \`needs_info\` (\`waitingKind: needs_decision\`) if it blocks that issue; a standing policy question → \`docs/proposals/<topic>.md\` marked *pending sign-off* |
| An audit or scan finding | an observation | memory, until it becomes work with a deliverable |
| A fix you already made by hand | a record | move the status, capture the learning in memory |

### Residuals — fix them, don't file them

Under-filing ships bugs. Measured case: four separate stages flagged an unauthenticated data leak, each asked for a follow-up to be filed, none was, and the leak shipped.

Filing was the wrong correction. Measured 2026-08-18 on forge-dev: 30 open \`draft\`s, the oldest untouched for 54 days, most of them fixable defects a stage deferred rather than fixed — two of them (ISS-791, ISS-845) describing drafts being filed and forgotten while themselves sitting filed and forgotten.

So anything a stage wants to hand onward routes as:

1. **You can fix it here** → **fix it**, and declare it under \`Extra fixes:\` in your comment. This is the default and covers most residuals. A declared extra fix is authorized work, not scope-creep — review judges it on merit.
2. **It must not ship without other work** → a \`blocks\` edge onto the issue that would otherwise ship without it.
3. **It needs a human decision** → \`needs_info\` + \`waitingKind: needs_decision\` + \`reason\` when it blocks this issue; a standing policy question → a line in \`docs/proposals/\`.

Filing a NEW issue is not on that list. If it fits none of the three, say it in a comment on the issue you are already working on — silence is the only thing that is never acceptable.

### When you find one that is not work — act on it, don't leave it

Finding a filed item that fails the gates is not someone else's job. You are the cheapest person to fix it, because you have just read it.

1. **Comment first** — which gate it fails, and where the content went (the memory entry, the proposals file, the issue it duplicates). A status move with no comment leaves the next reader unable to tell why.
2. **Then move it**: \`needs_info\` when a human owes you requirements and it could become real work; \`dropped\` when it is not work at all.
3. **Non-work leaves by \`dropped\`, never by \`closed\`.** \`closed\` means the work shipped: it is reached only from \`awaiting_release\`, by a release that claimed the issue (\`CLOSE_ONLY_BY_RELEASE\`), with its merge recorded (\`CLOSE_REQUIRES_SHIPPED\`). \`dropped\` is terminal without the claim, and it expires this issue's outgoing \`blocks\` edges so nothing is left waiting on an issue that can never land.

Do not move it INTO \`draft\` — nothing may transition into \`draft\`, by design. \`dropped\` is the exit for something that turned out not to be work.

### Then read
Statuses, the four exits from \`draft\`, and the description contract: guide \`pipeline-and-issue-lifecycle\`. Which tool for which intent: guide \`agent-setup\`.

Public copy of this page, no auth required: \`GET /api/guides/what-is-an-issue.md\`.`,
};

export const WRITING_AN_ISSUE_GUIDE: CoreGuide = {
  slug: 'writing-an-issue',
  audience: 'agent',
  title: 'Writing an issue',
  summary:
    'The three shapes an issue body takes and how to tell which one you are writing, why technical detail is placed rather than deleted, and how to use a mermaid diagram or an attached HTML artifact instead of prose.',
  version: 2,
  body: `## Writing an issue

A reader must get the problem in about fifteen seconds. How you get them there depends on which of three things you are writing, so pick the shape FIRST — most of the unreadable issue bodies in this tracker are the wrong shape, not bad writing.

| You are writing | Shape | Required |
|---|---|---|
| **One symptom** with one cause — a missing focus ring, a rule to add, a slice already scoped elsewhere | Opening line, then **Evidence** | 2 blocks |
| **A problem** whose cost, spread or mechanism a reader will not guess | The six blocks below | 4 blocks + Evidence |
| **An epic or a design record** — locked decisions, tiers, children | The six blocks below, then a **Decisions** block kept intact | 4 blocks + Decisions + Evidence |

Do not inflate the first shape into the second. A diagram of *"tab to the toggle → no ring appears"* has two nodes and tells the reader nothing the title did not; a *Who it hurts* table with one row is a sentence in a costume. Both make the issue longer and no clearer, which is the one thing this format exists to prevent.

Do not compress the third shape into the second either. In an epic the locked decisions ARE the deliverable, and an agent that re-derives a rejected option has done the work twice. Summarise the problem in the four blocks, then keep every decision, its rejected alternatives and its sequencing under **Decisions**. The four blocks are for the reader deciding whether to care; **Decisions** is for whoever builds it.

The six blocks, in this order. The last two appear only when they earn it.

| Block | Rule |
|---|---|
| **Opening line** | One or two sentences in a blockquote: what is wrong, and what it costs. Plain language — no function, table or file names. |
| **Who it hurts** | A table, at most four rows: *who · what they hit · how often or how wide*. If no row can be filled, this is probably not an issue — check the four gates in \`what-is-an-issue\`. |
| **Now → wanted** | Exactly one diagram, at most eight nodes. It replaces a paragraph; it never accompanies one. |
| **What to do** | At most six bullets, each an outcome someone can observe. Not function names — and not acceptance criteria, which are decided when the issue RUNS, not when it is filed. |
| **Waiting on a decision** | Only when genuinely blocked. State the question and what each answer costs. |
| **Evidence** | Always last. Every row carries *date · what was measured · source*. If it cannot be measured it is an opinion — cut it. |

### Technical detail is placed, not deleted

\`file:line\`, column names, SQL, commit hashes, schema fields: these belong in **Evidence**, or in a comment. Never in the first four blocks.

This is a placement rule, not a ban. A verified constraint — *"this table has no \`started_at\` column"* — cost real work to establish, and whoever builds the thing still needs it. Its problem is standing in the reader's way, not existing.

### Diagrams

A fenced \`mermaid\` block renders as a diagram in issue descriptions, plans and comments. Prefer it over prose and over ASCII art: it is a few hundred characters, and an agent reading the issue through the API still understands it as text.

\`\`\`mermaid
flowchart LR
  A["Rebase finishes"] --> B{"Can the warning<br/>be cleared?"}
  B -->|no path exists| C["Still flagged stale"]
\`\`\`

### When mermaid is not enough

Attach a self-contained \`.html\` file. It renders inline as a sandboxed artifact, in issues and in comments alike.

Do NOT paste that HTML into the description. The description is truncated before it reaches an agent's prompt (8,000 characters by default), and a styled page is large enough on its own to push the real content past that limit — the agent then receives markup and loses the requirements. An attachment sits outside the prompt path, so it costs nothing.

### Comments

Same discipline, shorter. Lead with the outcome, put the trace underneath. A comment is the right home for detail the description should not carry — which is what makes the placement rule above affordable.`,
};

export const PIPELINE_AND_ISSUE_LIFECYCLE_GUIDE: CoreGuide = {
  slug: 'pipeline-and-issue-lifecycle',
  audience: 'agent',
  title: 'Pipeline & issue lifecycle',
  summary:
    "What belongs in a description, the ten statuses an issue moves through and the guard each move carries, why a run's progress is its step and not a status, status-last discipline, why a park returns to the status it left, the three kinds of `needs_info`, and who owns which derived fields.",
  version: 13,
  body: `## Pipeline & issue lifecycle

### An issue is a unit of WORK — draft vs open
\`draft\` never dispatches; \`open\` auto-triages and immediately spawns a pipeline run, burning a runner slot. Creating a note-only issue at \`open\` is the single most common way to accidentally start unwanted pipeline work.

But \`draft\` is not a notepad either. Apply the test before you create anything: **an issue is work someone must do.** If nothing needs doing, it is not an issue — \`draft\` makes it invisible, not appropriate, and nobody ever opens the issue list looking for documentation. A note, learning, decision or record goes to project memory, \`POST /api/memory\` (durable business logic → repo \`docs/\`). Keep \`draft\` for follow-ups that need work later. Red flags: \`open-as-note\` AND \`draft-as-note\`.

### Working an issue directly, outside the pipeline
\`draft\` vs \`open\` is not the whole choice. \`draft\` has exactly **two** exits — \`open\` and \`dropped\` — and it is never entered again. What you do after admitting it is what makes a direct session cheap or expensive:

| You have | Do | Why |
|---|---|---|
| Finished the work entirely by hand; the pipeline has nothing left to do | \`open\`, claim it, \`in_progress\`, mark merged, \`awaiting_release\`; a release closes it | An issue closes only through a release (a release batch, or a recorded release), and only with its merge recorded |
| Started it yourself and are building it | \`open\`, then \`in_progress\` holding a lease | \`in_progress\` is refused (\`NO_HOLDER\`) while nothing holds the issue, so a master cannot race an agent into the worktree you are in |
| Not started it; you want the pipeline to do the whole thing | \`open\` | The driver takes it from there |
| Decided against it; the work will not happen | \`dropped\` with a reason | Terminal, and does NOT stamp \`merged_at\` — this is the discard \`closed\` should not be used for |
| Looked at it, not doing it now | leave \`draft\` | Costs nothing, dispatches nothing |

How far the work got is never a status: it is \`workState\` — the run's \`step\` (triage, clarify, plan, build, test, release), the \`branch\` it builds on and the \`headSha\` it pushed. Write those with \`PATCH /api/issues/:id\` \`{ workState }\`.

### A status says WHO the issue waits on, never WHAT exists
Every status answers one question — whose move is next. It is declared per status in \`pipeline/status-assertions.ts\`, and a run's progress inside \`in_progress\` is its step on \`issue_work_state\`, not a rung of its own. So do not read a status as a promise that code was written, pushed or merged.

The evidence questions are answered by row fields instead, and you read them directly: \`merged_at\` (it landed), \`workState.branch\` (a branch exists), \`workState.headSha\` and the implementation handoff's \`commitSha\`. \`merged_at\` is caller-asserted rather than verified — the merge mark (\`POST /api/issues/:id/merge\`) writes what the caller says landed, and no transition writes it at all — so it is evidence of a claim, which is what an evidence field is.

**\`closed\` means the work shipped, and \`dropped\` is the exit for everything else.** A close is refused (\`CLOSE_REQUIRES_SHIPPED\`) while the issue carries no \`merged_at\`, and the database refuses the same TRANSITION whatever route it took: \`trg_issues_closed_means_shipped\` names the issue and the rule on any UPDATE moving a row into \`closed\` with no claim, on any INSERT creating one there, and on any write clearing the claim from under a row already standing there — raw SQL included. **The rule governs the transition and not the state**, so rows closed before it landed keep what they hold: they still read \`closed\` with no \`merged_at\`, they are still writable, and migration \`0304_closed_means_shipped\` counted them in a \`NOTICE\` when it ran rather than deciding for them. Whoever owns such a row marks it merged where the work landed, or moves it to \`dropped\` where it did not, and no sweep decides them by rule. Use \`dropped\` for anything discarded: a note, a question, a duplicate, something already done. Where the work DID land outside the pipeline, claim it first with \`POST /api/issues/:id/merge\` naming where it landed. **Recording a landing moves no status**: the mark (or the host's merge webhook) records the merge and nothing else, and the run moves the issue to \`awaiting_release\` itself once the merge is recorded and the verdicts hold. On a project whose work lands outside git — its project document's \`source.type\` is \`storefront\` or \`none\` — a timestamp names nothing that landed, so the mark carries \`data.landing\` (the live URL, CMS entry or storefront resource the work now is) and a move into \`awaiting_release\` or \`closed\` whose mark names none is refused the same way; a commit is not asked for there.

One thing about \`dropped\` is worth knowing before you reach for it: **it releases the dependents it was holding, and you do not retract their edges by hand.** \`issues/drop-cascade.ts\` expires this issue's outgoing \`blocks\` edges inside the same transaction that moves the status, and names the dependents it freed back to you, so a rollback takes the expiry with it. \`closed\` claims the work shipped, \`dropped\` claims only that it will not happen, and neither leaves an issue waiting on something that can never land.

### The status set, and it is closed

Ten statuses. Every move below is enforced by \`issues/apply-transition.ts\`, and every guard refuses by name (\`issues/transition-guards.ts\`).

\`\`\`
draft ─▶ open ─▶ in_progress ─▶ approved ─▶ in_progress ─▶ awaiting_release ─▶ closed
  │       ▲         │  (steps: triage · clarify · plan · build · test)     │  (step: release)  │
  │     reopen ◀────┴──────────────────────────────────────────────────────┴───────────────────┘
  └─▶ dropped
needs_info / on_hold: entered from open, reopen, in_progress, approved, awaiting_release; left back to that status
\`\`\`

| Status | Waits on | Guard on the way in |
|---|---|---|
| \`draft\` | a holder of \`issues.admit\`, to admit it | filed here; never re-entered (\`ILLEGAL_TRANSITION\`). An issue filed by an actor without \`issues.admit\` is born here |
| \`open\` | a master, to take it | \`issues.admit\`, to file an issue here or promote a \`draft\` (\`PERMISSION_FORBIDDEN\`); admin holds it by role, a member or an agent's membership only where the project's grant names it |
| \`reopen\` | a master, to take it again | a reason (\`TRANSITION_REASON_REQUIRED\`); from \`awaiting_release\` or \`closed\` |
| \`in_progress\` | the run holding it; its step is the progress | something holds it — a lease or a run (\`NO_HOLDER\`); from \`open\`, \`reopen\` or \`approved\`, no live \`blocks\` edge from an unsettled blocker (\`ISSUE_BLOCKED\`), no unapproved workflow design (\`WORKFLOW_DESIGN_NOT_APPROVED\`), and no contract wait an approved version has not settled (\`CONTRACT_WAIT_UNSETTLED\`) — the same refusals meet a lease, a run session or a pool job taken over it |
| \`approved\` | a master; the next run goes straight to build | plan and criteria written (\`PLAN_REQUIRED\`), and, where the project document sets \`plan.approval.required\`, made by a holder of \`plans.approve\` (\`PERMISSION_FORBIDDEN\`) |
| \`needs_info\` | a person, to answer, decide or supply | the question as \`reason\` and its \`waitingKind\` (\`needs_answer\`, \`needs_decision\`, \`needs_resource\`) |
| \`on_hold\` | the person who paused it | a reason |
| \`awaiting_release\` | the release (a holder of \`releases.approve\`, where nothing releases automatically) | a deliberate move by the run: the merge recorded (\`MERGE_NOT_RECORDED\`), and every criterion's latest verdict passes and names its identity (\`NO_WORK_EVIDENCE\`, \`VERDICT_IDENTITY_REQUIRED\`), recorded after the issue's latest reopen (\`VERDICT_PREDATES_REOPEN\`); a project document with \`delivery.verdictsRequired: false\` waives this, and the move's record says \`verdicts-waived\` |
| \`closed\` | nobody | only from \`awaiting_release\`, and only by a release that claimed the issue — a finished release batch or a recorded release (\`CLOSE_ONLY_BY_RELEASE\`) — with its merge recorded (\`CLOSE_REQUIRES_SHIPPED\`) |
| \`dropped\` | nobody | a reason (\`VOID_REASON_REQUIRED\`) |

**Leaving a park returns to the status it left**, which \`issue_work_state.left_status\` records on the way in — never a guess, and not always \`open\`. That return is the park's own edge: the guard of the status it returns to is not asked again, because it was met when that status was first entered. A park taken at \`awaiting_release\` goes back to \`awaiting_release\`; an answered \`needs_info\` question returns the issue there too (\`pipeline/answer-resume.ts\`). A park that predates the record (migration 0346 found no history to read it from) carries no left status, and a person names where it resumes.

**A failed check goes to \`reopen\`, from \`awaiting_release\` or \`closed\`.** Inside \`in_progress\` a failed test is not a status at all: the run goes back to its build step.

**The legacy statuses.** \`confirmed\`, \`clarified\`, \`developed\`, \`testing\`, \`tested\`, \`releasing\` and \`waiting\` are not statuses: the first six were steps of a run written as statuses, which is how an issue came to rest at \`developed\` with no owner of the next move, and \`waiting\` folded into \`needs_info\` with its kind kept. Every door refuses each by name and maps none: a move, a list filter or a search filter naming one answers 422 \`ISSUE_STATUS_LEGACY\`, each refusal carrying \`received\` and \`validStatuses\`. A run's progress inside a status is \`workState.step\`.

### What is enforced
Every move not in the table above is refused with \`ILLEGAL_TRANSITION\`, naming the moves that are legal from where the issue stands. One move is a recovery rather than a claim: an \`in_progress\` issue that nothing holds any more — its run ended without moving it, the reconciler found it wedged, or a judge that is not its builder failed a criterion and let go — is handed back to \`open\`, \`approved\` or \`reopen\`, the status its run took it from (the recovery edges of \`@forge/contracts/issue-machine:ISSUE_MACHINE\`, drawn in revision 8), and only while nothing holds it. The kernel makes it on its own whenever a run session ends, whatever its outcome; a person or a judge makes it explicitly with \`recovery: true\` in the \`POST /api/issues/:id/transition\` body, sending a failed verdict back to \`reopen\` with the failed criteria as the reason. Anywhere else \`recovery\` is refused \`ILLEGAL_TRANSITION\` by name. Nothing closes an issue but a release, so a release batch is where a missing \`releaseNotes\` is refused, at the claim, with \`RELEASE_RECORD_MISSING\`. \`dropped\` has no exit: reopening a dropped issue would carry \`merged_at\` NULL into an issue that then ships, so re-filing is the correct move.

Reason from the refusal, never from the shape of the ladder: each one names what was missing and the move that is legal.

### The description is a requirements contract, not an implementation script
A description is the one context channel every downstream step trusts without re-verifying, so what you put in it decides whether plan and code explore the repo or just obey a stale snapshot.

**Belongs** — the stable half, owned by the requester: the outcome and who it serves; business and domain rules; invariants stated as behaviour; what the user must see when it fails; explicit out-of-scope; acceptance criteria as observable outcomes; external-system facts the repo cannot know (a vendor API's required call order) — labelled as unverified reference material, not as instructions.

**Does not belong** — the volatile half, owned by plan and code reading the live repo: which files or components to touch; endpoint-by-endpoint call scripts and internal sequencing; "follow the pattern at <path>"; assertions about the current implementation state (these go stale fastest and do the most damage); anything that pre-decides a design that the plan step exists to decide on a staged project, and the driver's planning phase on an autonomous one.

Two rules follow, both enforced at triage:
- **Never promote a description's implementation claim to a verified fact.** Either check it against the live repo in this run and say you did, or record it as "claimed by author, unverified". Writing "(verified: …)" without checking costs a whole downstream run.
- **When a prescriptive description arrives anyway** — common, humans paste vendor docs and audit output — DEMOTE it, don't delete it. Move the prose under "Reference material from the author — UNVERIFIED, verify against the repo before relying on it" and keep the requirement/AC section authoritative. Don't silently trust it; don't throw away genuine third-party knowledge either.

### Status is always the last action
Within a pipeline step: do your real work, post your findings/decision comment, write your handoff — status transition comes **last**, after all of that. The next step only picks the issue up once status has actually moved, so setting it early (before the comment lands) means the next step can start reading a half-written record.

### The parks, reachable from every live status
\`needs_info\` (a person must answer, decide or supply something) and \`on_hold\` (a deliberate pause) are entered from \`open\`, \`reopen\`, \`in_progress\`, \`approved\` and \`awaiting_release\` — set one the moment the condition is true rather than forcing a step that can't succeed. \`on_hold\` specifically means "active work, paused on purpose" — don't use it to park work that never started (leave that at \`draft\`) and don't use it to survive a mechanical crash (the system already reverts and retries those automatically).

### Leaving a park goes back where it came from
Leaving costs nothing beyond naming the status the park left — \`issue_work_state.left_status\` — or crossing to the other park, or \`dropped\`. Any other target is refused with \`ILLEGAL_TRANSITION\` naming the one it returns to. If you set it back and no job appears, that is a real fault (a stuck runner, a held job, a blocking dependency), not a rule — read \`pipelineHealth.waitingOn\`.

### \`needs_info\` says what it is stopped on
**A human is needed.** Only an agent or a human ever writes it — no failure path, no gate, nothing in core. Three kinds, and the kind is REQUIRED (\`WAITING_KIND_REQUIRED\`); core never guesses it:

| Kind | What it means | What unblocks it |
|---|---|---|
| \`needs_answer\` | a question about the requirements | the answer |
| \`needs_decision\` | a person must decide something the agent cannot (a tradeoff, a scope call, an approval) | the decision |
| \`needs_resource\` | a person must supply something the agent cannot create (a test account, credentials, third-party data) | the resource |

A plan awaiting approval and a tradeoff awaiting a call are both \`needs_decision\`. These were the old \`waiting\` park's kinds; \`waiting\` folded into \`needs_info\` with its kind kept (ISS-54).

**A step that cannot RUN is not \`needs_info\`.** No runner, provider quota, project budget, retries spent — the JOB is \`held\` and the issue stays where it is. \`pipelineHealth.waitingOn.reason = 'job_held'\` names the condition, and nothing is being asked of you: a capacity hold resumes itself when capacity returns.

### \`needs_info\` is a question, and a question has an answer box

It takes **three** fields, and two of them are not the same sentence:

| Field | Says | Required |
|---|---|---|
| \`reason\` | why the work stopped | yes — 422 without it |
| \`waitingKind\` | what it is stopped on | yes — 422 without it |
| \`needs\` | what a person must supply for it to start again | no, and send it anyway |

\`needs\` mints a free-text question in the SAME transaction as the status write and the reason comment, so a park either carries its question or does not commit. **That question is the only thing a person can answer.** Omitting \`needs\` does not skip the question: it mints one saying the run did not say what would settle this, which is true and is a worse thing to have said — unless a question blocked on a person is already open on the issue, which is then the question the park waits on, and nothing is asked twice.

Write it as the ask, not as the reason again. *"Choose: (a) accept the landed part and close with criterion 35 recorded as failing, or (b) keep this open and the turn runner is its remaining work"* is answerable. *"blocked on a decision"* is the reason wearing the ask's clothes.

**Who answers, and how.** A person, on the issue page, in the project's chat room, or at \`POST /api/questions/:id/answer { text | optionId, round }\` — a personal token is refused there, and an agent token answers only a question addressed to a master or a peer; \`round\` is required because an answer binds to the round the person was shown. Then, in order: a live session is sent the answer on stdin; a box that registered a waiter reads it back itself and nothing is dispatched; otherwise the issue moves back to the status the park left, with the answer on the record.

**The mint is gated on agency, not on the field.** A park by a person mints nothing — they stopped their own work and own their own resume. Only an agent-held credential (an agent account or a paired device) mints, so a \`needs\` sent by a human-owned token reaches no reader.

### Stopping the pipeline costs you a written reason
\`needs_info\`, \`on_hold\`, \`reopen\` and \`dropped\` are **rejected without a \`reason\`** (422). Pass it in the \`POST /api/issues/:id/transition\` body (\`note\` also counts); it is posted as a comment before the status flips, so it cannot go missing afterwards. \`waitingKind\` is REFUSED on every target but \`needs_info\` (422 \`WAITING_KIND_NOT_APPLICABLE\`) — no other target takes it, so put the ask in \`reason\`.

Entering a park costs a sentence; leaving one costs nothing. That asymmetry is deliberate.

Write the reason for the person who will read it, not for the audit trail. "blocked" is not a reason. "Need a Stripe test account with 3DS enabled — I cannot create one, and the checkout AC cannot be walked without it" is: it says what is needed, why the agent cannot get it, and what it unblocks.

There is no cap on how many times an issue may be reopened — the stop signal is judgement, not arithmetic: ~5 rounds with no movement means a human is needed, while 5 rounds each making progress is normal work.

### \`merged_at\` is written deliberately, and by nothing else
Two things write it: \`POST /api/issues/:id/merge\`, which is a claim you make, and an observed merge of a pull request Forge has projected. No transition stamps it as a side effect — closing did until ISS-1108 and no longer does, and the \`mergeStates.baseBranch\` rule that once stamped it on the way out of a state was removed before that. \`DELETE /api/issues/:id/merge\` clears a claim you made wrongly; it is not a step anything routine owes, and it is refused on a \`closed\` issue — \`closed\` means the work shipped, so reopen it first and take \`dropped\` from there where the work never landed.

### Derived fields you don't hand-set
- \`plan\` — written by the **plan** step. A reporter who pre-fills it deletes that step's reason to exist, and risks a plan agent trusting it instead of exploring. Red flag: \`plan-by-hand\`.
- \`acceptanceCriteria\` — written by **clarify/plan**. Draft ACs from the requester belong in \`description\` prose, not in this field.
- \`merged_at\` — you (or your step) stamp this one explicitly when you merge to the base branch and then park at a manual gate; everything else about pipeline status is either the ladder you're walking or a bounce state above. It is **caller-asserted, never verified against git** — so before stamping it, confirm the commit is actually reachable from the target branch, and never read someone else's \`merged_at\` as proof a merge happened.

When you report an issue, fill \`title\`, \`description\`, \`priority\`, \`category\` — and leave the rest to the pipeline.

### A crash is not a reason to hold
If your job fails mechanically (process crash, non-zero exit), the system itself reverts the issue to the stage's entry status and re-dispatches with a retry budget — you never need to (and shouldn't) set \`on_hold\` to paper over that.`,
};
