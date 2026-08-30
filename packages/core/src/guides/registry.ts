// Forge capability-guide registry — a code-defined, server-canonical index of
// how-to-use guides for Forge's own features (test credentials, dependencies,
// memory, deploy safety, pipeline lifecycle, uploads). Two live read surfaces
// consume this module: the `forge_guide` MCP tool (`mcp/tools/forge-guide.ts`)
// and the public `GET /api/guides` routes (`guides/routes.ts`).
//
// Why a code module and not a DB table or `forge_knowledge` scope:'global':
// - "Server-canonical, read live, no disk-sync" only constrains the
//   CONSUMER's disk (no local shadow file) — it says nothing about where the
//   server keeps its bytes. A guide ships atomically with the code it
//   documents, gets PR review, and needs no per-environment seeder that can
//   silently diverge.
// - A product-global guide has no `projectId`, so there is nothing to gate —
//   this sidesteps bolting a membership bypass onto `forge_knowledge` (every
//   action there asserts member/writer on a caller-supplied projectId).
// - Runtime-editable, per-project guidance already exists one tier down
//   (`forge_knowledge` entries / `projectFacts`); this global tier
//   deliberately does not duplicate it.
//
// Altitude rule for every body (NT1 — teach how to use the capability well:
// ordering, gotchas, cardinal rules). Do NOT re-dump tool schemas (Tool
// Search already supplies those) and do not restate the status ladder /
// enums (`prompt/facts/registry.ts` owns those).
//
// Cycle constraint: no DB/env/side-effect imports here, mirroring
// `prompt/facts/registry.ts` — the route, the MCP tool, and the tests all
// import this module without a live DB.

import { CONFORMANCE_GUIDE } from './conformance-guide.js';
import type { ForgeGuide } from './types.js';

export type { ForgeGuide };

export const FORGE_GUIDES: readonly ForgeGuide[] = [
  {
    slug: 'project-settings-and-test-credentials',
    title: 'Project settings & test credentials',
    summary:
      'Where to fetch repo paths, branches, workspace setup, preview URLs, and test credentials — and why forge_config never returns them.',
    version: 2,
    body: `## Project settings & test credentials

Two tools, two different jobs — mixing them up is the single most common Forge discoverability miss.

- **\`forge_projects.get\`** — deployment-shaped facts: repo path, base/production branch, \`workspaceSetup\` (how to bring this repo's workspace to a buildable state), and \`previewDeploy\` (staging/beta URLs + \`testCredentials\` for logging into a preview environment as a test user). This is the ONLY place test credentials live.
- **\`forge_config\`** — process-shaped facts: \`pipelineConfig\` (stage gates, status ladder overrides), \`stateContext\`, \`projectFacts\` (+ \`projectFactsConfig\` for the always-inject tier), categories. It deliberately does **not** return credentials or preview URLs — don't go looking for them there, and don't add them there either.

### Rules
1. Never hardcode a repo path, branch name, or test credential in a skill body, prompt, or comment — always fetch it live. A hardcoded value silently drifts the moment the project's settings change.
2. Never echo a fetched credential past the immediate authentication step (into a commit message, a PR description, or tool output) — treat it as a secret even though it's a test account.
3. When you need to change \`forge_config\` (e.g. \`pipelineConfig.states\`, \`projectFacts\`), **GET the current config first, then send a complete entry.** These are nested maps — a blind partial write clobbers sibling keys you never read.
4. If a project has no \`previewDeploy\` configured, there is no staging environment to test against; don't invent one.
5. \`workspaceSetup\` is the project's own setup procedure — install commands, hook setup, toolchain quirks — and it is prose, not a script anything executes. It is what a stage follows instead of guessing when it lands in a broken checkout. **If it is empty and you worked the procedure out, write it back** with \`forge_projects.update\` (\`workspaceSetup\`), recording only steps you ran and saw succeed. Set it while onboarding a project, next to the repo URL — Settings → Runners → Git access in the UI.

### Common mistake this guide exists to prevent
An agent hits a login wall on a preview deploy, can't find credentials in \`forge_config\`, and either asks a human or gives up. The credentials were one tool call away, on \`forge_projects.get\`.

The same shape costs tokens rather than a stall: a stage lands in a checkout whose hooks are missing, works out the install procedure from the lockfile, fixes it, and says nothing. The next job on that project pays for the same derivation, and the one after that. \`workspaceSetup\` exists so that happens once.`,
  },
  {
    slug: 'issue-dependencies-and-decompose',
    title: 'Issue dependencies & decompose',
    summary:
      'How blocks edges gate dispatch, the merged_at unblock signal, why decompose lifecycle is system-owned, and the one decompose action that IS yours — which differs by pipeline mode.',
    version: 5,
    body: `## Issue dependencies & decompose

### Relation kinds
Edges are directional \`fromIssue --kind--> toIssue\`:
- \`blocks\` — **the only kind that affects dispatch.** A → blocks → B means B cannot dispatch until A's code has reached the base branch — normally, until A has \`merged_at\` set. A reopened issue stays a blocker even if its prior merge stamp remains. A closed issue without \`merged_at\` unblocks B only when the project's base branch cannot be stamped structurally. It is **not** gated on A reaching \`released\`: a blocker parked at a manual release gate already unblocks B the instant its \`merged_at\` is stamped.
- \`relates\`, \`duplicates\`, \`parent\` — metadata only, no dispatch effect.
- \`decomposes\` — epic → child; engages the system-owned decomposition lifecycle below. Do not create this edge by hand outside that flow.

### Setting a blocks edge — avoid the create-then-block race
- Blocker known **at create time** → pass it in the create call itself (\`data.relations: [{ kind: 'blocks', dependsOnId }]\`), committed before the issue dispatches. This is atomic.
- Both issues already exist → \`forge_issues action=update\` with \`data.relations: [{ kind: 'blocks', dependsOnId }]\`, relative to the issue you are updating (\`dependsOnId\` = it blocks me, \`blocksId\` = I block it). This works with any credential class and commits the edge before the call's own status transition. Or set it via the PM dependency tool with \`from\` = the blocker — that route needs a paired-device token.
- Red flag: creating the new issue at \`open\` and setting the blocks edge in a second call — the issue can dispatch in the gap between the two calls.
- Verify, don't assume: \`forge_issues action=get\` returns \`relations.blocks\` and \`relations.blockedBy\`, each edge flagged \`expired\` once its \`validUntil\` has passed. Retract an edge by re-sending it with \`validUntil\` in the past — the write reports \`updated: true\`.

### The merged_at unblock signal
A dependent dispatches the moment its blocker's \`merged_at\` is stamped, not when the blocker reaches \`released\`. \`merged_at\` auto-stamps only when a project's pipeline actually walks through the base-merge state. If you merge an issue's branch to the base branch and then **park** at that state manually (a gate the system doesn't auto-advance through), nothing stamps it and every downstream dependent stalls silently — stamp it yourself right after the merge lands.

### Decompose is system-owned
Decomposing is part of deciding HOW an issue gets built — on a staged project the plan step declares the \`decomposes\` edges; on an autonomous project the driver declares them from its planning phase. Either way it is not something to do by hand while working an unrelated issue.

The flow: write each child's plan, create the children (they land at \`draft\`), link each with a \`decomposes\` edge, then the parent is automatically parked at \`waiting\` — a human review gate. Approving the parent auto-cascades the children to whichever status **this project's driver dispatches**. The parent's own integration work is held until every child has \`merged_at\` set (or is \`closed\`), then runs last.

**The human has exactly one action here: approve the split, and the status you write depends on the project's mode.**

| Project mode | Statuses the parent may be decomposed FROM | Approve by moving the PARENT |
|---|---|---|
| staged (the default) | \`confirmed\`, \`clarified\`, \`waiting\` | \`waiting → approved\` |
| \`autonomous\` | \`open\`, \`in_progress\`, \`waiting\` | \`waiting → open\` |

That single transition is what promotes every child. Nothing else about decompose status is yours to set.

On an autonomous project \`approved\` is not a status the driver reads and the board does not offer it, so the children are promoted to \`open\` instead — writing \`approved\` on the parent still works (it is forwarded to \`open\`), but \`open\` is the one to reach for. The park itself is exempt from that mode's rule that an agent's \`waiting\` becomes \`needs_info\`: a comment on a decomposed parent is discussion of the split, not approval of it, so answering it does not release the gate — only the transition does.

Do not hand-set parent or child status. Two failure modes, both observed:
- Moving children forward yourself skips the cascade, so they arrive without the parent's plan behind them and each burns a full triage/clarify/plan cycle rediscovering it.
- A child you have already moved past \`draft\`/\`on_hold\` is **skipped** by the cascade for good — those are the only two statuses it promotes from. If you have already done this, park the children back at \`on_hold\` and re-enter \`approved\` on the parent; the cascade then picks them up correctly.

Leaving the parent at \`waiting\` is not a safe default either — its own integration step can never dispatch from there. A decomposed epic that nobody approves is stalled, not waiting.

### Recording a note without triggering a pipeline run
Create the issue at \`draft\`, never \`open\` — \`open\` auto-triages and spawns a pipeline run, burning a runner slot for something that was only meant to be a note.`,
  },
  {
    slug: 'memory-and-knowledge',
    title: 'Memory & knowledge',
    summary:
      'The three context tiers (memory, knowledge, projectFacts), recall-first discipline, and the verify-at-recall feedback loop.',
    version: 1,
    body: `## Memory & knowledge

Forge separates durable context into three tiers, each with a different job:

- **\`forge_memory\`** — per-project semantic search over accumulated notes, decisions, fix-patterns, policies. Not auto-loaded into any prompt; you recall it deliberately. \`search({ projectId, query, topK, sourceFilter? })\` returns scored hits; \`write({ projectId, source, sourceRef, textContent, metadata? })\` upserts on the natural key \`(projectId, source, sourceRef)\` — reusing a \`sourceRef\` refines the existing entry instead of duplicating it.
- **\`forge_knowledge\`** — curated, structured knowledge entries (overview / workflow / rule / reference kinds) with an explicit \`injection\` policy (\`always\` / \`on_demand\` / \`none\`). This is the project's authored knowledge base, distinct from the free-form memory stream.
- **\`projectFacts\`** (via \`forge_config\`) — small always-inject or fetch-on-demand facts rendered directly into the pipeline preamble.

### Recall-first discipline
Before you design, reproduce, or fix something non-trivial: recall what prior work already established for the area you're about to touch, so you neither contradict a settled decision nor rediscover it from scratch. Run one or two focused queries on the concrete nouns of the task — a generic query on the whole project wastes a call and returns noise.

### Verify at recall — the loop that keeps memory clean
A memory hit is point-in-time. Once you've checked it against the live code:
- If it still holds → report \`forge_memory.feedback({ ..., verdict: 'confirmed' })\`. This protects the entry from decay.
- If it's been superseded → report \`verdict: 'outdated', evidence: '<what disproved it>'\`. This archives it immediately instead of letting the next agent trip over the same stale claim.
A verification you silently do but never report is a cleaning signal thrown away — the entry stays stale for the next reader.

### Capturing a new lesson
Only when it's reusable by a *different* agent on a *different* issue — a convention, a non-obvious gotcha, a fix pattern. Issue-specific detail belongs in that issue's \`sessionContext\`, not memory. Search first (\`sourceFilter: ['knowledge']\`) before writing, to avoid duplicating an existing entry under a different \`sourceRef\`.`,
  },
  {
    slug: 'deploy-safety',
    title: 'Deploy safety',
    summary:
      'Confirm before an outward-facing deploy, poll status in the foreground, and what a failed deployment means for status.',
    version: 1,
    body: `## Deploy safety

Deploys via \`forge_coolify_deploy\` are hard to reverse and affect a shared, externally-visible environment — treat every call with the same care as a production push.

### Before you deploy
- Confirm you're targeting the intended environment. An explicit integration/service scope is a hard filter — don't rely on defaults picking the right one, especially near a release, when it's easy to accidentally redeploy production mid-pipeline instead of a staging target.
- A production deploy outside the release stage's human-confirm gate is a red flag, not a shortcut — don't bypass it just because you're blocked.

### While it runs — poll in the foreground
A pipeline step is a single, one-shot turn: when it ends, the whole process group is killed, including anything you backgrounded. If you background the deploy-status poll and then end your turn, the job may report success or failure and you will never see it — the issue is left parked with no verification. Poll in the foreground so the turn blocks until you actually have the answer. If the wait would blow your time budget, hand off cleanly (comment + status) rather than backgrounding and exiting.

### After it lands
Verify liveness on the deployed environment before declaring success — a deploy that "succeeded" per the platform can still serve a broken app. On a failed deployment: report it, do not silently retry into a loop, and do not leave the issue in a state that implies success.`,
  },
  {
    slug: 'what-is-an-issue',
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
| A note, learning, or convention | knowledge | \`forge_memory_write\` (durable business logic → repo \`docs/\`) |
| An open question needing a human decision | a decision | a comment on the issue that raised it + \`waiting\` if it blocks that issue; a standing policy question → \`docs/proposals/<topic>.md\` marked *pending sign-off* |
| An audit or scan finding | an observation | memory, until it becomes work with a deliverable |
| A fix you already made by hand | a record | move the status, capture the learning in memory |

### Residuals — fix them, don't file them

Under-filing ships bugs. Measured case: four separate stages flagged an unauthenticated data leak, each asked for a follow-up to be filed, none was, and the leak shipped.

Filing was the wrong correction. Measured 2026-08-18 on forge-dev: 30 open \`draft\`s, the oldest untouched for 54 days, most of them fixable defects a stage deferred rather than fixed — two of them (ISS-791, ISS-845) describing drafts being filed and forgotten while themselves sitting filed and forgotten.

So anything a stage wants to hand onward routes as:

1. **You can fix it here** → **fix it**, and declare it under \`Extra fixes:\` in your comment. This is the default and covers most residuals. A declared extra fix is authorized work, not scope-creep — review judges it on merit.
2. **It must not ship without other work** → a \`blocks\` edge onto the issue that would otherwise ship without it.
3. **It needs a human decision** → \`waiting\` + \`waitingKind\` + \`reason\` when it blocks this issue; a standing policy question → a line in \`docs/proposals/\`.

Filing a NEW issue is not on that list. If it fits none of the three, say it in a comment on the issue you are already working on — silence is the only thing that is never acceptable.

### When you find one that is not work — act on it, don't leave it

Finding a filed item that fails the gates is not someone else's job. You are the cheapest person to fix it, because you have just read it.

1. **Comment first** — which gate it fails, and where the content went (the memory entry, the proposals file, the issue it duplicates). A status move with no comment leaves the next reader unable to tell why.
2. **Then move it**: \`needs_info\` when a human owes you requirements and it could become real work; \`closed\` when it is not work at all.
3. **Closing non-work needs \`unmark\`.** \`closed\` auto-stamps \`merged_at\`, and that stamp releases every \`blocks\` dependent as if the work had shipped. Call \`forge_issues action=unmark\` right after, or you silently unblock work that is still genuinely blocked.

Do not move it INTO \`draft\` — nothing may transition into \`draft\`, by design. \`closed\` + \`unmark\` is the exit for something that turned out not to be work.

### Then read
Statuses, the four exits from \`draft\`, and the description contract: guide \`pipeline-and-issue-lifecycle\`. Which tool for which intent: guide \`agent-setup\`.

Public copy of this page, no auth required: \`GET /api/guides/what-is-an-issue.md\`.`,
  },
  {
    slug: 'writing-an-issue',
    title: 'Writing an issue',
    summary:
      'The three shapes an issue body takes and how to tell which one you are writing, why technical detail is placed rather than deleted, and how to use a mermaid diagram or an attached HTML artifact instead of prose.',
    version: 2,
    // cm:guard the HTML-artifact paragraph must keep saying "attach, never paste": `prompt/user.ts` truncates `description` at DEFAULT_FIELD_CAPS.description before an agent sees it, so an inlined page evicts the requirements instead of merely bloating them
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

A fenced \`mermaid\` block renders as a diagram in issue descriptions, plans and comments. Prefer it over prose and over ASCII art: it is a few hundred characters, and an agent reading the issue through MCP still understands it as text.

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
  },
  {
    slug: 'pipeline-and-issue-lifecycle',
    title: 'Pipeline & issue lifecycle',
    summary:
      'What belongs in a description, the four exits from draft (including the direct-ship route and the discard that does not stamp `merged_at`), what the state machine actually enforces vs merely recommends, status-last discipline, why leaving a park is as free as entering it, the two authored kinds of `waiting`, and who owns which derived fields.',
    version: 7,
    body: `## Pipeline & issue lifecycle

### An issue is a unit of WORK — draft vs open
\`draft\` never dispatches; \`open\` auto-triages and immediately spawns a pipeline run, burning a runner slot. Creating a note-only issue at \`open\` is the single most common way to accidentally start unwanted pipeline work.

But \`draft\` is not a notepad either. Apply the test before you create anything: **an issue is work someone must do.** If nothing needs doing, it is not an issue — \`draft\` makes it invisible, not appropriate, and nobody ever opens the issue list looking for documentation. A note, learning, decision or record goes to \`forge_memory_write\` (durable business logic → repo \`docs/\`). Keep \`draft\` for follow-ups that need work later, and for decompose children awaiting parent approval. Red flags: \`open-as-note\` AND \`draft-as-note\`.

### Working an issue directly, outside the pipeline
\`draft\` vs \`open\` is not the whole choice. \`draft\` has **four** exits, and picking the wrong one is what makes a direct session expensive:

| You have | Set | Why |
|---|---|---|
| Finished the work entirely by hand; the pipeline has nothing left to do | \`closed\` | See the \`merged_at\` warning below before you do this |
| Written AND pushed the \`ISS-*\` branch yourself; you want review → test → release run on it | \`developed\` **+ \`sessionContext.branch\`** | Enters at the REVIEW gate. Walking \`open\` instead re-runs triage/clarify/plan/code over already-finished work |
| Not started it; you want the pipeline to do the whole thing | \`open\` | Full ladder from triage |
| Decided against it; the work will not happen | \`dropped\` | Terminal, and does NOT stamp \`merged_at\` — this is the discard \`closed\` should not be used for |
| Looked at it, not doing it now | leave \`draft\` | Costs nothing, dispatches nothing |

Two of the four are easy to mix up. The \`developed\` route is the one people miss: it is the direct-ship path, where you did the coding and the pipeline still gates it. And \`dropped\` is the one people reach for \`closed\` instead of.

**Closing is not free, and \`dropped\` is why you rarely need it.** \`closed\` auto-stamps \`merged_at\`, and \`merged_at\` is exactly what releases every \`blocks\` dependent waiting on this issue — so closing something you ABANDONED silently unblocks work that should still be blocked. \`dropped\` is terminal without the stamp (dependents are freed by edge expiry instead), so use it for anything discarded and keep \`closed\` for work that actually landed. If you have already closed an abandoned issue, call \`forge_issues\` \`unmark\` to clear the stamp.

### What is actually enforced, and what is only advice
The runtime gate is permissive: **any status may move to any status, except that nothing may move INTO \`draft\`**, and \`draft\` itself may only leave to \`open\`, \`developed\`, \`closed\` or \`dropped\`. That is the whole rule. \`dropped\` is legal, and it is a dead end by **convention, not by the gate**: the \`transitions\` map offers it no exit because reopening a dropped issue would carry \`merged_at\` NULL into an issue that then ships, so re-filing is the correct move. The recommended discard for non-work is still \`closed\` + \`unmark\`, per **Closing is not free** above.

The status ladder you see in prompts, in the UI's next-state suggestions, and in the \`transitions\` map in the source is the **recommended happy path**, not a constraint. Do not infer that a hop is illegal because it is not listed there, and do not build multi-hop detours to reach a status you could have set directly. If a transition is genuinely refused you will get a typed error naming the reason (\`TRANSITION_REASON_REQUIRED\` on a park with no rationale, \`WAITING_KIND_REQUIRED\` on a \`waiting\` that does not say which kind, \`ILLEGAL_TRANSITION\` on either half of the rule above — \`draft\` as a target, or a \`draft\` leaving to anything else) — reason from that error, never from the shape of the ladder.

### The description is a requirements contract, not an implementation script
A description is the one context channel every downstream step trusts without re-verifying, so what you put in it decides whether plan and code explore the repo or just obey a stale snapshot.

**Belongs** — the stable half, owned by the requester: the outcome and who it serves; business and domain rules; invariants stated as behaviour; what the user must see when it fails; explicit out-of-scope; acceptance criteria as observable outcomes; external-system facts the repo cannot know (a vendor API's required call order) — labelled as unverified reference material, not as instructions.

**Does not belong** — the volatile half, owned by plan and code reading the live repo: which files or components to touch; endpoint-by-endpoint call scripts and internal sequencing; "follow the pattern at <path>"; assertions about the current implementation state (these go stale fastest and do the most damage); anything that pre-decides a design the plan step exists to decide.

Two rules follow, both enforced at triage:
- **Never promote a description's implementation claim to a verified fact.** Either check it against the live repo in this run and say you did, or record it as "claimed by author, unverified". Writing "(verified: …)" without checking costs a whole downstream run.
- **When a prescriptive description arrives anyway** — common, humans paste vendor docs and audit output — DEMOTE it, don't delete it. Move the prose under "Reference material from the author — UNVERIFIED, verify against the repo before relying on it" and keep the requirement/AC section authoritative. Don't silently trust it; don't throw away genuine third-party knowledge either.

### Status is always the last action
Within a pipeline step: do your real work, post your findings/decision comment, write your handoff — status transition comes **last**, after all of that. The next step only picks the issue up once status has actually moved, so setting it early (before the comment lands) means the next step can start reading a half-written record.

### Bounce states, reachable from anywhere
\`needs_info\` (requirements missing/unclear), \`waiting\` (blocked on a human decision), \`reopen\` (regression or failed check), \`on_hold\` (deliberate pause) are not restricted to the happy-path ladder — set one the moment the condition is true rather than forcing a step that can't succeed. \`on_hold\` specifically means "active work, paused on purpose" — don't use it to park work that never started (leave that at \`draft\`) and don't use it to survive a mechanical crash (the system already reverts and retries those automatically).

### Leaving a park is symmetric with entering one
Entering \`waiting\`/\`on_hold\` is free from anywhere, and so is leaving. Set the next status through the UI, REST or MCP and the next step dispatches — no actor check, no \`unblock\` flag, no admin. If you set a forward status and no job appears, that is a real fault (a stuck runner, a held job, a blocking dependency), not a rule — read \`pipelineHealth.waitingOn\`.

An earlier version of this pipeline refused every non-human exit from a park. It cost four refused resume attempts on one issue (ISS-163) and produced no work; RFC 0002 removed it.

### \`waiting\` means one thing, in two flavours
**A human is needed.** Only an agent or a human ever writes it — no failure path, no gate, nothing in core. Two authored kinds:

| Kind | What it means | What unblocks it |
|---|---|---|
| \`needs_decision\` | a person must decide something the agent cannot (a tradeoff, a scope call, an approval) | the decision, then any status write |
| \`needs_resource\` | a person must supply something the agent cannot create (a test account, credentials, third-party data) | the resource, then any status write |

The kind is REQUIRED and core never guesses it. A plan awaiting approval and a decompose parent awaiting review are both \`needs_decision\`.

**A step that cannot RUN is not \`waiting\`.** No runner, provider quota, project budget, retries spent — the JOB is \`held\` and the issue stays at its stage. \`pipelineHealth.waitingOn.reason = 'job_held'\` names the condition, and nothing is being asked of you: a capacity hold resumes itself when capacity returns.

### Stopping the pipeline costs you a written reason
\`reopen\`, \`waiting\` and \`needs_info\` are the three statuses that stop the pipeline, and all three are **rejected without a \`reason\`** (422). Pass it on the \`forge_issues\` call (\`note\` also counts); it is posted as a comment before the status flips, so it cannot go missing afterwards. \`waiting\` additionally requires \`waitingKind\`.

Entering a park costs a sentence; leaving one costs nothing. That asymmetry is deliberate and it is the opposite of the old rule, which let anyone stop the pipeline silently and then argued about who was allowed to restart it.

Write the reason for the person who will read it, not for the audit trail. "blocked" is not a reason. "Need a Stripe test account with 3DS enabled — I cannot create one, and the checkout AC cannot be walked without it" is: it says what is needed, why the agent cannot get it, and what it unblocks.

This replaced a check on WHO answered a \`needs_info\` question. That check existed because the question itself was invisible, so the only thing left to police was the answer's author. A question on the record needs no such policing.

There is no cap on how many times an issue may be reopened — the stop signal is judgement, not arithmetic: ~5 rounds with no movement means a human is needed, while 5 rounds each making progress is normal work.

### Leaving a state can stamp \`merged_at\` behind you
Transitioning OUT of the project's \`mergeStates.baseBranch\` state stamps \`merged_at\` — including a hop you made for an unrelated reason, and including one where nothing was merged. That stamp is what releases every \`blocks\` dependent, so a diagnostic transition near the merge state can unblock work that should still be blocked. After any hand transition out of that state, check the field and clear it with \`forge_issues\` \`unmark\` if no merge landed.

### Derived fields you don't hand-set
- \`plan\` — written by the **plan** step. A reporter who pre-fills it deletes that step's reason to exist, and risks a plan agent trusting it instead of exploring. Red flag: \`plan-by-hand\`.
- \`acceptanceCriteria\` — written by **clarify/plan**. Draft ACs from the requester belong in \`description\` prose, not in this field.
- Decompose parent/child status — system-owned; moving it by hand breaks the kickoff.
- \`merged_at\` — you (or your step) stamp this one explicitly when you merge to the base branch and then park at a manual gate; everything else about pipeline status is either the ladder you're walking or a bounce state above. It is **caller-asserted, never verified against git** — so before stamping it, confirm the commit is actually reachable from the target branch, and never read someone else's \`merged_at\` as proof a merge happened.

When you report an issue, fill \`title\`, \`description\`, \`priority\`, \`category\` — and leave the rest to the pipeline.

### A crash is not a reason to hold
If your job fails mechanically (process crash, non-zero exit), the system itself reverts the issue to the stage's entry status and re-dispatches with a retry budget — you never need to (and shouldn't) set \`on_hold\` to paper over that.`,
  },
  {
    slug: 'attachments-and-uploads',
    title: 'Attachments & uploads',
    summary:
      'Presigned-URL upload flow vs base64, and how to read the content of an existing attachment.',
    version: 1,
    body: `## Attachments & uploads

### Writing an attachment — presigned URL, not base64
For anything beyond a tiny snippet, use the \`forge_uploads\` presigned-URL pattern instead of inlining base64 bytes into a tool call: request an upload URL, then upload the file straight to storage. Base64 in a request body is slow to transmit and burns context tokens carrying bytes that don't need to pass through the model at all.

### Reading an attachment's content
\`forge_uploads\` with \`action=fetch\` reads an **existing** attachment by \`{ target: "issue" | "comment", attachmentId }\`:
- Images (png/jpeg/gif/webp) come back as a viewable image block — use this whenever an issue or comment references a screenshot you need to actually look at, not just acknowledge.
- Text/markdown comes back inline.
- PDFs, video, and oversized files come back as metadata + a download URL only — fetch does not try to inline everything.

### The typical flow
1. Create the comment or issue update that will carry the attachment.
2. Request a presigned upload URL from \`forge_uploads\`.
3. Upload the file directly to the returned URL.
4. Later, any reader (including a different agent) calls \`action=fetch\` on that attachment to see its actual content — never assume a filename or mime type tells you enough; fetch it when the content matters to the task.`,
  },
  {
    slug: 'agent-setup',
    title: 'Working in a Forge-managed repo',
    summary:
      'Start here: what Forge owns, the recall-first rule, draft vs open, and the red flags that waste a runner slot.',
    version: 1,
    body: `## Working in a Forge-managed repo

If a repo has a \`.forge/\` directory or an \`mcp.json\` naming a \`forge\` server, its issues, pipeline
and durable memory live in Forge, not in the repo. Read this before your first write.

### The one rule that saves the most time
**Recall before you design.** Project memory is NOT loaded into your context automatically —
\`forge_memory_search({ projectId, query, topK: 5 })\` is a call you have to make. Skipping it is how
agents rediscover settled decisions, or contradict them. Treat every hit as point-in-time: verify it
against live code or git before you rely on it.

### What Forge owns, and the tool for each
| You need | Call |
|---|---|
| Issues, status, tasks | \`forge_issues\`, \`forge_comments\` |
| Ordering between issues | \`forge_issues.create\`/\`.update\` with \`data.relations\`, or \`forge_project_pm action=set_dependency\` (\`from\` = the blocker; needs a paired device) |
| Repo path, branches, preview URLs, test credentials | \`forge_projects.get\` |
| Pipeline gates, \`projectFacts\` | \`forge_config\` |
| A decision, learning or convention worth keeping | \`forge_memory_write\` |
| Deeper per-package detail | \`forge_knowledge\` (list/get/search) |
| How a Forge feature actually works | \`forge_guide\` — or fetch these same bytes at \`/api/guides/<slug>.md\` |

### draft vs open — the costly one
\`open\` auto-triages and immediately spawns a pipeline run, burning a runner slot. \`draft\` never
dispatches. So:
- Work you want an agent to pick up now → \`open\`.
- Work for later, or a follow-up you just want recorded → \`draft\`.
- A note, learning or decision → **not an issue at all**; write it to memory. Nobody browses the
  issue list for notes.

### Red flags
- **prose-deps** — describing an ordering in text instead of setting a \`blocks\` edge. Only the edge
  gates dispatch; prose gates nothing.
- **open-as-note** / **draft-as-note** — filing a note as an issue.
- **plan-by-hand** — pre-filling \`plan\` or \`acceptanceCriteria\` on create. Those are written by the
  clarify and plan steps; filling them deletes those steps' reason to exist.
- **wholesale-config-clobber** — patching a nested map (\`pipelineConfig.states\`, \`projectFacts\`)
  without reading it first. These are replace-not-merge; send a complete entry.
- **skip-recall** — see above.
- **fix-by-hand-and-forget** — fixing something outside the pipeline and leaving no status move and
  no recorded learning.

### Writing an issue
Fill \`title\`, \`description\`, \`priority\`, \`category\`. Keep the description a **requirements
contract** — outcome, business rules, invariants, what is out of scope. Not an implementation script
naming files and endpoints: those claims go stale and, in practice, outrank live exploration.`,
  },
  {
    slug: 'update-pipeline-reconcile',
    title: 'Update Pipeline — reconcile bundle reference',
    summary:
      'Every field the Master agent and verifiers receive, what each one is worth trusting, and the refusal contract that runs before either agent starts.',
    version: 1,
    body: `## Update Pipeline — reconcile bundle reference

Reference for Update Pipeline stage ② (Reconcile). The decision rules live in the agents' own
instructions; this is the data dictionary and the surrounding contract. Read it when you need the
meaning of a field, not to decide a verdict.

### How a reconcile run happens
\`\`\`
⓪ AUTHOR    a human writes an Update Packet { change · story · intent_class · applies_to }
① ENFORCE   whatever is expressible as platform policy ships as CODE → every project at once,
            and emits the currently-effective invariant set
② RECONCILE per project: Master agent reads the bundle → verdict + gate
            → 3 independent verifiers vote → publish, park for a human, or escalate
③ CONVERGE  new hash → manifest → runner pulls (including deletes)
④ OBSERVE   runner reports what is ACTUALLY on disk; each job records the hash it ran with
⑤ AUDIT     every state change writes an event in the same transaction
\`\`\`

### The bundle
\`ReconcileBundleSnapshot\` — read fresh at trigger time, never from an older snapshot.

| Field | What it is | Trust |
|---|---|---|
| \`change\` | the diff description | authored |
| \`story\` | **why** this change exists and what it must not break | human, mandatory |
| \`intentClass\` | \`invariant\` / \`procedure\` / \`enhancement\` | sets adaptation latitude |
| \`appliesTo\` | which skill the packet targets | authored |
| \`provenance\` | commit, author, version | derived |
| \`runningBody\` | the body **observed on the project's device** — not the copy Forge stores | observed |
| \`runningHash\` | hash of that observed body | observed |
| \`charter\` | the project's Divergence Charter: differences the owner declared intentional. \`null\` when none exists | human |
| \`projectFacts\` | facts injected into every agent on this project | project config |
| \`pipelineConfig\` | the project's pipeline configuration | project config |
| \`recentRunEvidence\` | recent runs of the stage this skill serves | observed |
| \`priorReconcileHistory\` | earlier reconcile runs for this same skill | observed |
| \`invariantSet\` | the platform invariants in force right now (stage ① output) | hard constraint |
| \`mustNotBreak\` | assertions derived from non-revertable charter entries | absolute |
| \`sources\` | per-field provenance label: \`human\` / \`from-code\` / \`observed-from-run\` / \`agent-assertion\` | — |
| \`readAt\` | when the bundle was assembled | freshness stamp |

Two fields are easy to misread. \`runningBody\` is what a device reported, so it may differ from what
Forge pushed — that difference is the whole point of having it. \`mustNotBreak\` is not advisory; an
entry there came from an incident.

### The refusal contract (C1–C5)
The server validates these **before** either agent runs. A missing input is a refusal, not a
degraded run — there is no best-effort mode.

| | Guarantee | Born from |
|---|---|---|
| C1 | **Sufficient** — every decision-relevant input present | agents coding against \`plan: null\` |
| C2 | **Fresh** — read at decision time, with a \`readAt\` stamp | a stale session context reopened a passing issue |
| C3 | **Sourced** — every fact carries a provenance label | an agent wrote its own guess into a verified-ground-truth field |
| C4 | **No fabrication** — \`story\` must be human, \`runningBody\` must be observed | same incident |
| C5 | **Deterministic** — same packet + same project state ⇒ same bundle | so a differing outcome is a model problem, not an input problem |

A refusal is recorded with the specific missing input. If you triggered a run and got one, the
message names exactly what to fix.

### Verdicts and the gate
The Master agent returns one of \`no-op\` / \`apply\` / \`apply-with-adaptation\` / \`escalate\`, and
**declares the gate itself** — \`auto\` (publishes once a majority of verifiers pass) or \`human\`
(parks for the owner). No server-side rule overrides that declaration; the verifiers re-judge it
adversarially instead.

There is **no automatic revert.** A wrong \`auto\` reaches every runner on the project, and the only
recovery is a manual step back to the run's \`lastGoodBody\`. That asymmetry is why the instructions
tell both agents to prefer \`human\` when uncertain.

### Failure containment
A failure at any stage keeps the last-good body running. The skill is never left empty and never
silently changed, and the run records why it stopped.`,
  },
  CONFORMANCE_GUIDE,
] as const;

const GUIDE_BY_SLUG = new Map<string, ForgeGuide>(FORGE_GUIDES.map((g) => [g.slug, g]));

/** Body-free index — slug/title/summary/version only, never guide bodies. */
export function listGuides(): Array<Omit<ForgeGuide, 'body'>> {
  return FORGE_GUIDES.map(({ body, ...rest }) => {
    void body;
    return rest;
  });
}

/** Full guide by slug, or `undefined` if unknown. */
export function getGuide(slug: string): ForgeGuide | undefined {
  return GUIDE_BY_SLUG.get(slug);
}
