## Pipeline & issue lifecycle

### An issue is a unit of WORK — draft vs open
`draft` never dispatches; `open` auto-triages and immediately spawns a pipeline run, burning a runner slot. Creating a note-only issue at `open` is the single most common way to accidentally start unwanted pipeline work.

But `draft` is not a notepad either. Apply the test before you create anything: **an issue is work someone must do.** If nothing needs doing, it is not an issue — `draft` makes it invisible, not appropriate, and nobody ever opens the issue list looking for documentation. A note, learning, decision or record goes to `forge_memory_write` (durable business logic → repo `docs/`). Keep `draft` for follow-ups that need work later. Red flags: `open-as-note` AND `draft-as-note`.

### Working an issue directly, outside the pipeline
`draft` vs `open` is not the whole choice. `draft` has **four** exits, and picking the wrong one is what makes a direct session expensive:

| You have | Set | Why |
|---|---|---|
| Finished the work entirely by hand; the pipeline has nothing left to do | `closed` | See the `merged_at` warning below before you do this |
| Written AND pushed the `ISS-*` branch yourself | `developed` **+ `sessionContext.branch`** | `developed` is the review rung — it says the code exists and owes a proof. The branch field, not the status, is what says WHERE it exists, so set both. Walking `open` instead re-runs the whole thing over already-finished work |
| Started it, still building, branch not pushed | `in_progress` | Same rung. Dispatches nothing — promoting instead is what races an agent into the worktree you are in |
| Not started it; you want the pipeline to do the whole thing | `open` | The one status that dispatches; the driver takes it from there |
| Decided against it; the work will not happen | `dropped` | Terminal, and does NOT stamp `merged_at` — this is the discard `closed` should not be used for |
| Looked at it, not doing it now | leave `draft` | Costs nothing, dispatches nothing |

Two are easy to mix up. `developed` vs `in_progress` is the pushed/not-pushed line, and `sessionContext.branch` is what makes `developed` actionable — the rung without the branch is a review request naming no code. And `dropped` is the one people reach for `closed` instead of.

### A status says WHERE the work is, never WHAT exists
Every status answers one question — which gate the work sits at, and whose move is next. That is the whole of what it claims, it is declared per status in `pipeline/status-assertions.ts`, and there is no field in that declaration in which a status could claim anything else. So do not read a rung as a promise that code was written, pushed or merged, and never refuse a rung because you cannot make such a promise true.

The evidence questions are answered by three row fields instead, and you read them directly: `merged_at` (it landed), `sessionContext.branch` (a branch exists), and the implementation handoff's `commitSha`. `merged_at` is caller-asserted rather than verified — `mark_merged` writes what the caller says landed, and no transition writes it at all — so it is evidence of a claim, which is what an evidence field is.

This is why work you built and pushed but cannot merge yourself stays at `in_progress` with `sessionContext.branch` set: the branch field says the code exists, and the rung says only that a session holds the issue. Four runs on 2026-09-06 reached that identical state and recorded four different statuses because the promise was undefined (ISS-940). One more consequence worth knowing: on this lane `open` is the ONLY status a job is dispatched at, so every other live status is already waiting on a person — reaching one is not how you ask for work to continue.

**`closed` means the work shipped, and `dropped` is the exit for everything else.** A close is refused (`CLOSE_REQUIRES_SHIPPED`) while the issue carries no `merged_at`, and the database refuses the same TRANSITION whatever route it took: `trg_issues_closed_means_shipped` names the issue and the rule on any UPDATE moving a row into `closed` with no claim, on any INSERT creating one there, and on any write clearing the claim from under a row already standing there — raw SQL included. **The rule governs the transition and not the state**, so rows closed before it landed keep what they hold: they still read `closed` with no `merged_at`, they are still writable, and migration `0304_closed_means_shipped` counted them in a `NOTICE` when it ran rather than deciding for them. Whoever owns such a row marks it merged where the work landed, or moves it to `dropped` where it did not; `docs/proposals/closes-that-predate-the-shipped-rule.md` carries the terms. Use `dropped` for anything discarded: a note, a question, a duplicate, something already done. Where the work DID land outside the pipeline, claim it first with `forge_issues` `mark_merged`, naming the commit it landed at in `data.commit` where there is one, then close; a `landing` is refused on a project whose work lands in git, so an issue there whose change lands no file in the repository declares `landingShape: outside_git` on itself first and is then marked with its `landing`. On a project whose work lands outside git — kind `website`, whose store is the source of truth — a timestamp names nothing that landed, so the mark carries `data.landing` (the live URL, CMS entry or storefront resource the work now is) and a close whose mark names none is refused the same way; a commit is not asked for there.

One thing about `dropped` is worth knowing before you reach for it: **it releases the dependents it was holding, and you do not retract their edges by hand.** `issues/drop-cascade.ts` expires this issue's outgoing `blocks` edges inside the same transaction that moves the status, and names the dependents it freed back to you, so a rollback takes the expiry with it. That is the companion half of the rule above — `closed` claims the work shipped, `dropped` claims only that it will not happen, and neither leaves an issue waiting on something that can never land. The guidance here said the opposite until ISS-1108, and told readers to retract the edges themselves.

### The status set, and it is closed

Fourteen statuses. Which party owes the next move at each, and the two hops the system
actually refuses: the run/job invariant in `CLAUDE.md`.

```
              ┌──────────────────── needs_info / on_hold ────────────────────┐  (from ANY live
              │                                                             │   rung, back to
draft ─▶ open ─▶ confirmed ─▶ approved ─▶ in_progress ─▶ developed ─▶ testing ─▶ awaiting_release ─▶ releasing ─▶ closed
  │                                          │              │          │                                 │           │
  └─▶ dropped                                │              └─▶ reopen ◀─┘ (a failed check)               └─▶ reopen ─┘
                                             └──▶ closed (project with no release gate)
```

| Status | Claims | Whose move is next |
|---|---|---|
| `draft` | filed, not admitted | whoever triages it |
| `open` | claimable. **The only status that dispatches** | a master, by claiming |
| `confirmed` | a reader has said what the issue is, against the code | whoever executes it |
| `approved` | a decision, a plan and criteria exist — object now, not after | whoever builds it |
| `in_progress` | a session holds it | the run |
| `developed` | the code exists and owes a proof | whoever reviews it |
| `testing` | the proof is being run | whoever is testing it |
| `awaiting_release` | merged to the base branch, waiting for production | a person, by pressing RELEASE |
| `releasing` | a release was triggered and is running | the release batch |
| `needs_info` | a question a person owes an answer to | a person, by answering |
| `on_hold` | a pause a person chose — **not** a question | the person who paused it |
| `reopen` | a person disagreed with a close | a person, by routing it |
| `closed` | done — nothing enters it without `merged_at` | nobody |
| `dropped` | ended **without** stamping `merged_at` — it was not work | nobody |

`needs_info` and `on_hold` are enterable from **every** rung and from each other. `draft` cannot park (it already is a resting place) and `closed`/`dropped` cannot: a park after an end is a reopen, and `closed → reopen` already is that hop — on a staged project and on an autonomous one alike, where a person is its only writer.

**Leaving a park returns to the rung it left** — any of `open`, `confirmed`, `approved`, `in_progress`, `developed`, `testing` or `awaiting_release`, not always `open`. A park taken at `awaiting_release` is work already merged and waiting for production; sending it to `open` dispatches a fresh agent onto shipped work and loses its place at the gate. Today `pipeline/answer-resume.ts` sends an answered `needs_info` to `confirmed` once its last open question is answered — the rung that says its requirements are settled — or to `open` on a project whose `poolBacklog.statuses` admit nothing at `confirmed`, saying why on the thread; whatever rung it left, because nothing records where the park came from. So park at `needs_info` only for want of a requirement, and to ask a person about finished work, ask with `forge_questions` and leave the rung alone: a question marks its issue as waiting on a person and moves nothing, and an answer at any rung but `needs_info` moves nothing either.

**A failed check goes to `reopen`, not backwards down the ladder.** On the **staged** lane, `developed → reopen` and `testing → reopen` are the two rejection exits, and `reopen` routes to `in_progress` (rework) or back to `developed` (the proof was wrong, the code was not). On the **autonomous** lane neither rung is a driver status, so the agent never writes them; a person does, from the board. `isReopenEntry` counts both as real rejections in the quality metric on either lane; only `in_progress → reopen` is excluded, because that one is the system recovering a dead run — which is why it is the one shape both modes produce.

**Only `finish` and `abort` may write out of `releasing`.** An agent that could leave it would be declaring its own release finished. A batch that dies without either outcome hands its issues to `reopen` with the reason attached.

**Three retired statuses, and the trap is that all three still WORK.**

| Retired | What happens if you write it |
|---|---|
| `deploying` `pass` `staging` | gone from the enum — `forge_issues.update` **refuses** them, so you find out at once |
| `clarified` `tested` | still in the enum for rows that already hold them, so the write **SUCCEEDS silently**. Nothing dispatches at either, so the issue is stranded until a person moves it by hand |
| `released` | renamed to `awaiting_release` (migration 0228). The old name is refused. It was the past tense of an action that had not happened, and it doubled as the release *trigger* because there was no button; the button and `releasing` took that job |
| `waiting` | still written, still being retired. An agent's `waiting` is rewritten to `needs_info` on an autonomous project |

`tested` is the one to watch: forge-plugin still writes it where this chain says `testing`, and one project names it in `poolBacklog.statuses`. Until both move, treat a row at `tested` as a row at `testing` that owes a status fix (ISS-1022).

**`confirmed` and `approved` are NOT retired, and were for one day.** They were cut on 2026-09-10 with `clarified` and `tested`, on the rule that a rung earns its place only where a **different party** owes the next move at it — and under the single-driver pipeline one agent walked all four, so none of them did. The wave model splits triage from execution, which is exactly that party boundary, and forge-plugin's own ladder never stopped naming the two: a kernel calling them retired was the half that was wrong (ISS-976). Nothing dispatches at either, so a row resting on one reaches a master only where its project declares the status in `poolBacklog.statuses`.

Measured 2026-09-10, and it is why the other two stayed cut: while the default chain in the prompt named all six of the old middle rungs, agents walked them — **153 hops across 4 projects in 3 hours**, leaving **45 issues** standing on a status no job dispatches at. `clarified` and `tested` only ever recorded that a phase inside one session had finished, which the handoff already says.

### What is actually enforced, and what is only advice
The runtime gate is permissive: **any status may move to any status, except that nothing may move INTO `draft`**, and `draft` itself may only leave to `open`, `in_progress`, `developed`, `closed` or `dropped`. Two content rules sit beside it. **Nothing may ENTER `closed` while `merged_at` is null**, whatever the gate lists — so `draft` -> `closed` is a move the gate offers and the rule refuses, because a draft carries no claim until somebody marks one. And **an agent may not write `closed` while `releaseNotes` is null**, because `closed` is what every reader takes as shipped and a shipped issue with nothing written for it is the record lying. One exemption, and it is narrow: a HUMAN close, because an operator making the claim deliberately owns it. The batch release is not a second — it is refused earlier instead, at the claim, with `RELEASE_RECORD_MISSING`. What this guarantees is that a note exists ON THE ISSUE before an automated close; it does not guarantee a line reached `CHANGELOG.md`, which is a git artifact core never reads. `dropped` is legal, and it is a dead end by **convention, not by the gate**: the `transitions` map offers it no exit because reopening a dropped issue would carry `merged_at` NULL into an issue that then ships, so re-filing is the correct move. The discard for non-work is `dropped`, per **`closed` means the work shipped** above.

The status ladder you see in prompts, in the UI's next-state suggestions, and in the `transitions` map in the source is the **recommended happy path**, not a constraint. Do not infer that a hop is illegal because it is not listed there, and do not build multi-hop detours to reach a status you could have set directly. If a transition is genuinely refused you will get a typed error naming the reason (`TRANSITION_REASON_REQUIRED` on a park with no rationale, `WAITING_KIND_REQUIRED` on a `waiting` that does not say which kind, `RELEASE_RECORD_REQUIRED` on a close with no `releaseNotes` — set the field and close again, `{ section: 'Skip', userFacing: '-' }` is a complete answer, `ILLEGAL_TRANSITION` on either half of the rule above — `draft` as a target, or a `draft` leaving to anything else) — reason from that error, never from the shape of the ladder.

### The description is a requirements contract, not an implementation script
A description is the one context channel every downstream step trusts without re-verifying, so what you put in it decides whether plan and code explore the repo or just obey a stale snapshot.

**Belongs** — the stable half, owned by the requester: the outcome and who it serves; business and domain rules; invariants stated as behaviour; what the user must see when it fails; explicit out-of-scope; acceptance criteria as observable outcomes; external-system facts the repo cannot know (a vendor API's required call order) — labelled as unverified reference material, not as instructions.

**Does not belong** — the volatile half, owned by plan and code reading the live repo: which files or components to touch; endpoint-by-endpoint call scripts and internal sequencing; "follow the pattern at <path>"; assertions about the current implementation state (these go stale fastest and do the most damage); anything that pre-decides a design that the plan step exists to decide on a staged project, and the driver's planning phase on an autonomous one.

Two rules follow, both enforced at triage:
- **Never promote a description's implementation claim to a verified fact.** Either check it against the live repo in this run and say you did, or record it as "claimed by author, unverified". Writing "(verified: …)" without checking costs a whole downstream run.
- **When a prescriptive description arrives anyway** — common, humans paste vendor docs and audit output — DEMOTE it, don't delete it. Move the prose under "Reference material from the author — UNVERIFIED, verify against the repo before relying on it" and keep the requirement/AC section authoritative. Don't silently trust it; don't throw away genuine third-party knowledge either.

### Status is always the last action
Within a pipeline step: do your real work, post your findings/decision comment, write your handoff — status transition comes **last**, after all of that. The next step only picks the issue up once status has actually moved, so setting it early (before the comment lands) means the next step can start reading a half-written record.

### Bounce states, reachable from anywhere
`needs_info` (requirements missing/unclear), `waiting` (blocked on a human decision), `reopen` (regression or failed check), `on_hold` (deliberate pause) are not restricted to the happy-path ladder — set one the moment the condition is true rather than forcing a step that can't succeed. `on_hold` specifically means "active work, paused on purpose" — don't use it to park work that never started (leave that at `draft`) and don't use it to survive a mechanical crash (the system already reverts and retries those automatically).

### Leaving a park is symmetric with entering one
Entering `waiting`/`on_hold` is free from anywhere, and so is leaving. Set the next status through the UI, REST or MCP and the next step dispatches — no actor check, no `unblock` flag, no admin. If you set a forward status and no job appears, that is a real fault (a stuck runner, a held job, a blocking dependency), not a rule — read `pipelineHealth.waitingOn`.

An earlier version of this pipeline refused every non-human exit from a park. It cost four refused resume attempts on one issue (ISS-163) and produced no work; RFC 0002 removed it.

### `waiting` means one thing, in two flavours
**A human is needed.** Only an agent or a human ever writes it — no failure path, no gate, nothing in core. Two authored kinds:

| Kind | What it means | What unblocks it |
|---|---|---|
| `needs_decision` | a person must decide something the agent cannot (a tradeoff, a scope call, an approval) | the decision, then any status write |
| `needs_resource` | a person must supply something the agent cannot create (a test account, credentials, third-party data) | the resource, then any status write |

The kind is REQUIRED and core never guesses it. A plan awaiting approval and a tradeoff awaiting a call are both `needs_decision`.

**A step that cannot RUN is not `waiting`.** No runner, provider quota, project budget, retries spent — the JOB is `held` and the issue stays at its stage. `pipelineHealth.waitingOn.reason = 'job_held'` names the condition, and nothing is being asked of you: a capacity hold resumes itself when capacity returns.

### `needs_info` is a question, and a question has an answer box

It takes **two** fields, and they are not the same sentence:

| Field | Says | Required |
|---|---|---|
| `reason` | why the work stopped | yes — 422 without it |
| `needs` | what a person must supply for it to start again | no, and send it anyway |

`needs` mints a free-text question in the SAME transaction as the status write and the reason comment, so a park either carries its question or does not commit. **That question is the only thing a person can answer** — the comment lane that used to revive a park was cut on 2026-09-13. Omitting `needs` does not skip the question: it mints one saying the run did not say what would settle this, which is true and is a worse thing to have said — unless a question blocked on a person is already open on the issue, which is then the question the park waits on, and nothing is asked twice.

Write it as the ask, not as the reason again. *"Choose: (a) accept the landed part and close with criterion 35 recorded as failing, or (b) keep this open and the turn runner is its remaining work"* is answerable. *"blocked on a decision"* is the reason wearing the ask's clothes.

**Who answers, and how.** A person, on the issue page, in the project's chat room, or at `POST /api/questions/:id/answer { text | optionId, round }` — session only, a PAT is refused, and `round` is required because an answer binds to the round the person was shown. Then, in order: a live session is sent the answer on stdin; a box that registered a waiter reads it back itself and nothing is dispatched; otherwise the issue moves to `confirmed` (or `open`, where the project admits nothing at `confirmed`) with the answer on the record.

**The mint is gated on agency, not on the field.** A park by a person mints nothing — they stopped their own work and own their own resume. Only an agent-held credential (an agent account or a paired device) mints, so a `needs` sent by a human-owned token reaches no reader.

### Stopping the pipeline costs you a written reason
`reopen`, `waiting` and `needs_info` are the three statuses that stop the pipeline, and all three are **rejected without a `reason`** (422). Pass it on the `forge_issues` call (`note` also counts); it is posted as a comment before the status flips, so it cannot go missing afterwards. `waiting` additionally requires `waitingKind`, and `waitingKind` is REFUSED on every other target (422 `WAITING_KIND_NOT_APPLICABLE`) — no other target takes it, so put the ask in `reason`.

Entering a park costs a sentence; leaving one costs nothing. That asymmetry is deliberate and it is the opposite of the old rule, which let anyone stop the pipeline silently and then argued about who was allowed to restart it.

Write the reason for the person who will read it, not for the audit trail. "blocked" is not a reason. "Need a Stripe test account with 3DS enabled — I cannot create one, and the checkout AC cannot be walked without it" is: it says what is needed, why the agent cannot get it, and what it unblocks.

This replaced a check on WHO answered a `needs_info` question. That check existed because the question itself was invisible, so the only thing left to police was the answer's author. A question on the record needs no such policing.

There is no cap on how many times an issue may be reopened — the stop signal is judgement, not arithmetic: ~5 rounds with no movement means a human is needed, while 5 rounds each making progress is normal work.

### `merged_at` is written deliberately, and by nothing else
Two things write it: `forge_issues` `mark_merged`, which is a claim you make, and an observed merge of a pull request Forge has projected. No transition stamps it as a side effect — closing did until ISS-1108 and no longer does, and the `mergeStates.baseBranch` rule that once stamped it on the way out of a state was removed before that. `unmark` clears a claim you made wrongly; it is not a step anything routine owes, and it is refused on a `closed` issue — `closed` means the work shipped, so reopen it first and take `dropped` from there where the work never landed.

### Derived fields you don't hand-set
- `plan` — written by the **plan** step. A reporter who pre-fills it deletes that step's reason to exist, and risks a plan agent trusting it instead of exploring. Red flag: `plan-by-hand`.
- `acceptanceCriteria` — written by **clarify/plan**. Draft ACs from the requester belong in `description` prose, not in this field.
- `merged_at` — you (or your step) stamp this one explicitly when you merge to the base branch and then park at a manual gate; everything else about pipeline status is either the ladder you're walking or a bounce state above. It is **caller-asserted, never verified against git** — so before stamping it, confirm the commit is actually reachable from the target branch, and never read someone else's `merged_at` as proof a merge happened.

When you report an issue, fill `title`, `description`, `priority`, `category` — and leave the rest to the pipeline.

### A crash is not a reason to hold
If your job fails mechanically (process crash, non-zero exit), the system itself reverts the issue to the stage's entry status and re-dispatches with a retry budget — you never need to (and shouldn't) set `on_hold` to paper over that.