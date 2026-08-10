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

// cm:edge contract -> packages/core/src/guides/integration-guides.ts — that tier owns the `integration-<provider>` slug prefix; a code guide claiming it would be unreachable for any org that authored its own
export interface ForgeGuide {
  /** Stable, URL-safe id: kebab-case, `/^[a-z0-9][a-z0-9-]*$/`. */
  slug: string;
  title: string;
  /** ONE line — this is all the always-on index shows. */
  summary: string;
  version: number;
  /** Markdown body, NT1 altitude. */
  body: string;
}

export const FORGE_GUIDES: readonly ForgeGuide[] = [
  {
    slug: 'project-settings-and-test-credentials',
    title: 'Project settings & test credentials',
    summary:
      'Where to fetch repo paths, branches, preview URLs, and test credentials — and why forge_config never returns them.',
    version: 1,
    body: `## Project settings & test credentials

Two tools, two different jobs — mixing them up is the single most common Forge discoverability miss.

- **\`forge_projects.get\`** — deployment-shaped facts: repo path, base/production branch, and \`previewDeploy\` (staging/beta URLs + \`testCredentials\` for logging into a preview environment as a test user). This is the ONLY place test credentials live.
- **\`forge_config\`** — process-shaped facts: \`pipelineConfig\` (stage gates, status ladder overrides), \`stateContext\`, \`projectFacts\` (+ \`projectFactsConfig\` for the always-inject tier), categories. It deliberately does **not** return credentials or preview URLs — don't go looking for them there, and don't add them there either.

### Rules
1. Never hardcode a repo path, branch name, or test credential in a skill body, prompt, or comment — always fetch it live. A hardcoded value silently drifts the moment the project's settings change.
2. Never echo a fetched credential past the immediate authentication step (into a commit message, a PR description, or tool output) — treat it as a secret even though it's a test account.
3. When you need to change \`forge_config\` (e.g. \`pipelineConfig.states\`, \`projectFacts\`), **GET the current config first, then send a complete entry.** These are nested maps — a blind partial write clobbers sibling keys you never read.
4. If a project has no \`previewDeploy\` configured, there is no staging environment to test against; don't invent one.

### Common mistake this guide exists to prevent
An agent hits a login wall on a preview deploy, can't find credentials in \`forge_config\`, and either asks a human or gives up. The credentials were one tool call away, on \`forge_projects.get\`.`,
  },
  {
    slug: 'issue-dependencies-and-decompose',
    title: 'Issue dependencies & decompose',
    summary:
      'How blocks edges gate dispatch, the merged_at unblock signal, and why decompose lifecycle is system-owned.',
    version: 1,
    body: `## Issue dependencies & decompose

### Relation kinds
Edges are directional \`fromIssue --kind--> toIssue\`:
- \`blocks\` — **the only kind that affects dispatch.** A → blocks → B means B cannot dispatch until A's code has reached the base branch — concretely, until A has \`merged_at\` set OR A is \`closed\`. It is **not** gated on A reaching \`released\`: a blocker parked at a manual release gate already unblocks B the instant its \`merged_at\` is stamped.
- \`relates\`, \`duplicates\`, \`parent\` — metadata only, no dispatch effect.
- \`decomposes\` — epic → child; engages the system-owned decomposition lifecycle below. Do not create this edge by hand outside that flow.

### Setting a blocks edge — avoid the create-then-block race
- Blocker known **at create time** → pass it in the create call itself (\`data.relations: [{ kind: 'blocks', dependsOnId }]\`), committed before the issue dispatches. This is atomic.
- Both issues already exist → set the edge via the PM dependency tool with \`from\` = the blocker.
- Red flag: creating the new issue at \`open\` and setting the blocks edge in a second call — the issue can dispatch in the gap between the two calls.

### The merged_at unblock signal
A dependent dispatches the moment its blocker's \`merged_at\` is stamped, not when the blocker reaches \`released\`. \`merged_at\` auto-stamps only when a project's pipeline actually walks through the base-merge state. If you merge an issue's branch to the base branch and then **park** at that state manually (a gate the system doesn't auto-advance through), nothing stamps it and every downstream dependent stalls silently — stamp it yourself right after the merge lands.

### Decompose is system-owned
When a parent is too large to ship atomically: write each child's plan, create the children (they land at \`draft\`), link each with a \`decomposes\` edge, then the parent is automatically parked at \`waiting\` — a human review gate. Approving the parent auto-cascades approval to the children. The parent's own integration work is held until every child has \`merged_at\` set (or is \`closed\`), then runs last. Do not hand-set parent or child status during this flow — it breaks the kickoff.

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
    slug: 'pipeline-and-issue-lifecycle',
    title: 'Pipeline & issue lifecycle',
    summary:
      'What belongs in a description, draft vs open, status-last discipline, bounce states, and who owns which derived fields.',
    version: 2,
    body: `## Pipeline & issue lifecycle

### An issue is a unit of WORK — draft vs open
\`draft\` never dispatches; \`open\` auto-triages and immediately spawns a pipeline run, burning a runner slot. Creating a note-only issue at \`open\` is the single most common way to accidentally start unwanted pipeline work.

But \`draft\` is not a notepad either. Apply the test before you create anything: **an issue is work someone must do.** If nothing needs doing, it is not an issue — \`draft\` makes it invisible, not appropriate, and nobody ever opens the issue list looking for documentation. A note, learning, decision or record goes to \`forge_memory_write\` (durable business logic → repo \`docs/\`). Keep \`draft\` for follow-ups that need work later, and for decompose children awaiting parent approval. Red flags: \`open-as-note\` AND \`draft-as-note\`.

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
| Ordering between issues | \`forge_project_pm action=set_dependency\` (\`from\` = the blocker) |
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
