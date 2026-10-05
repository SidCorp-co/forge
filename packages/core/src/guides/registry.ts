// Forge capability-guide registry — a code-defined, server-canonical index of
// how-to-use guides for Forge's own features (test credentials, dependencies,
// memory, deploy safety, pipeline lifecycle, uploads). Two live read surfaces
// consume this module: the public `GET /api/guides` routes (`guides/routes.ts`) and the
// in-prompt guide pointers (`guides/guide-ref.ts`).
//
// Why a code module, and which pages belong here rather than in another of the four
// documentation homes: docs/modules/guides/where-a-page-lives.md.
//
// Altitude rule for every body (NT1 — teach how to use the capability well:
// ordering, gotchas, cardinal rules). Do NOT re-dump tool schemas (Tool
// Search already supplies those) and do not restate the status ladder /
// enums (`prompt/facts/registry.ts` owns those).

import { WORK_EVIDENCE_WAIVER_NOTE } from '@forge/contracts/issue-machine';
import {
  ALWAYS_INJECT_ENFORCEMENT_NOTE,
  ALWAYS_INJECT_GUARANTEE_NOTE,
} from '@forge/contracts/knowledge';
import { ASSISTANT_METHOD_GUIDE } from './assistant-method-guide.js';
import { CONFORMANCE_GUIDE } from './conformance-guide.js';
import { ECOSYSTEM_INBOX_GUIDE } from './ecosystem-inbox-guide.js';
import { FEEDBACK_TRIAGE_GUIDE } from './feedback-guide.js';
import {
  PIPELINE_AND_ISSUE_LIFECYCLE_GUIDE,
  WHAT_IS_AN_ISSUE_GUIDE,
  WRITING_AN_ISSUE_GUIDE,
} from './issue-guides.js';
import { RECORDS_GUIDE } from './records-guide.js';
import { REQUIREMENT_LIFECYCLE_GUIDE } from './requirements-guide.js';
import { RUNS_AND_MASTERS_GUIDE } from './runs-guide.js';
import { SUGGESTIONS_GUIDE } from './suggestions-guide.js';
import type { CoreGuide, ForgeGuide } from './types.js';
import { WORKFLOW_DESIGN_GUIDE } from './workflow-design-guide.js';
import { WORKFLOW_TEMPLATES_GUIDE } from './workflow-templates-guide.js';

const FORGE_GUIDES: readonly CoreGuide[] = [
  {
    slug: 'project-settings-and-test-credentials',
    audience: 'agent',
    title: 'Project settings & test credentials',
    summary:
      'Where to fetch repo paths, branches, workspace setup, preview URLs, and test credentials — and why the project config never returns them.',
    version: 4,
    body: `## Project settings & test credentials

Two reads, two different jobs — mixing them up is the single most common Forge discoverability miss.

- **\`GET /api/projects/:id\`** — name, slug and base branch. A checkout path is not here: each device binding names its own.
- **\`GET /api/projects/:id/config\` → \`projectDocument\`** — the project document: its repository (\`source.git.repository\`), its setup procedure (\`workspace.setup\`), each environment's tier, address, the branch it deploys from and the testing profile its testers get in through, and the promotions a landed change crosses. A testing profile names \`secret://\` references, never values, and its \`limits\` say what that environment does NOT have.
- **\`GET /api/projects/:id/policy\`** — the project's policy-v1 document: \`qa\`, intake, and each status's model and permission profile. Neither read carries project PROSE — a write naming \`projectFacts\` or \`projectFactsConfig\` is refused by name; the prose is the project's knowledge (\`GET /api/projects/:id/knowledge\`, or \`forge knowledge\`). It deliberately does **not** return credentials or preview URLs — don't go looking for them there, and don't add them there either.

  ${ALWAYS_INJECT_GUARANTEE_NOTE} ${ALWAYS_INJECT_ENFORCEMENT_NOTE}

### Rules
1. Never hardcode a repo path, branch name, or test credential in a skill body, prompt, or comment — always fetch it live. A hardcoded value silently drifts the moment the project's settings change.
2. Never echo a fetched credential past the immediate authentication step (into a commit message, a PR description, or tool output) — treat it as a secret even though it's a test account.
3. When you need to change the policy, **GET it first, then send the whole document with the revision you read** — \`PUT /api/projects/:id/policy\` with \`{ baseRevision, document }\`. A write against a revision that moved is refused by name, never merged. A knowledge entry is not one of them: a knowledge write replaces one slug whole, so there are no siblings to clobber.
4. \`environments.preview: null\` means this project HAS no preview side — a one-box project saying so, not a setting somebody forgot. Test against \`environments.live\` and don't invent a staging host. Equally, an empty \`environments.live.url\` is not permission to guess one: nothing in Forge derives a hostname from another.
5. \`workspace.setup\` is the project's own setup procedure — install commands, hook setup, toolchain quirks — and it is prose, not a script anything executes. It is what a stage follows instead of guessing when it lands in a broken checkout. **If it is empty and you worked the procedure out, write it back** into the project document (\`PUT /api/projects/:id/config\` with the \`baseRevision\` you read), recording only steps you ran and saw succeed.

### Common mistake this guide exists to prevent
An agent hits a login wall on a preview deploy, can't find credentials in the project config, and either asks a human or gives up. The environment's \`testing\` profile named them, as \`secret://\` references the job resolves.

The same shape costs tokens rather than a stall: a stage lands in a checkout whose hooks are missing, works out the install procedure from the lockfile, fixes it, and says nothing. The next job on that project pays for the same derivation, and the one after that. \`workspace.setup\` exists so that happens once.`,
  },
  {
    slug: 'issue-dependencies',
    audience: 'agent',
    title: 'Issue dependencies',
    summary:
      'How blocks edges gate dispatch, which blocker statuses release a dependent, how to set an edge without racing the first dispatch, and why splitting an oversized issue is plain work rather than a lifecycle.',
    version: 9,
    body: `## Issue dependencies

### Relation kinds
Edges are directional \`fromIssue --kind--> toIssue\`:
- \`blocks\` — **the only kind that affects dispatch.** A → blocks → B means B is held out of the set a master reads until A reaches \`awaiting_release\` — every criterion passed — or \`closed\`; every other status on A, \`in_progress\` at any step, \`approved\`, \`on_hold\` and \`needs_info\` included, keeps holding it (ISS-54: a built-but-unjudged A no longer releases B). A reopened A blocks again. **It is A's STATUS and not A's \`merged_at\`**: a blocker whose code has landed but whose criteria have not passed still holds B, and no gate anywhere in Forge reads \`merged_at\` to release a dependent. Retracting the edge — re-send it with \`validUntil\` in the past — and dropping A, which expires its edges for the same reason, both take B out of the held set **as far as Forge is concerned**. They do not yet release it at the master: \`forge next\` and \`forge advance\` in the \`forge\` plugin read the blocker's status and never the edge's expiry, so a B released this way is offered by Forge and still declined there until forge-plugin ISS-347 lands. Moving A forward is the route that works on both today.
- \`relates\`, \`duplicates\`, \`parent\` — grouping labels, no dispatch effect.
- \`decomposes\` — epic → child. ${WORK_EVIDENCE_WAIVER_NOTE} Ordering between the two is still a \`blocks\` edge.

### Setting a blocks edge — avoid the create-then-block race
- Blocker known **at create time** → pass it in the create call itself (\`POST /api/projects/:id/issues\` with \`relations: [{ kind: 'blocks', dependsOnId }]\`), committed before the issue dispatches. This is atomic.
- Both issues already exist → \`POST /api/issues/:id/dependencies\` with \`{ kind: 'blocks', dependsOnId }\` on the dependent issue (\`dependsOnId\` = the blocker). This works with any credential class.
- Red flag: creating the new issue at \`open\` and setting the blocks edge in a second call — the issue can dispatch in the gap between the two calls.
- Verify, don't assume: \`GET /api/issues/:id/dependencies\` lists the edges, each carrying \`expired\`; an edge holds the issue back only while its kind is \`blocks\` and it is not \`expired\` (its \`validUntil\` has passed). A \`relates\`, \`duplicates\`, \`parent\` or \`decomposes\` edge never blocks. Retract an edge with \`DELETE /api/issues/:id/dependencies/:edgeId\`, or by re-sending it with \`validUntil\` in the past.

### An issue bigger than one change
Splitting is ordinary work, not a lifecycle. Nothing parks a parent, nothing promotes a draft for you, and no edge holds a parent's own work back.

- Most of the time the halves belong to ONE session: plan them as ordered steps and build them on one branch, in order.
- When a half genuinely ships on its own, file it as its own issue at \`open\`, and if it must land first give the dependent a \`blocks\` edge naming it. Each issue then carries its own plan, criteria and review.
- Never file the halves at \`draft\` expecting something to wake them. \`draft\` dispatches nothing, and no approval cascades it.

### Recording a note without triggering a pipeline run
Create the issue at \`draft\`, never \`open\` — \`open\` auto-triages and spawns a pipeline run, burning a runner slot for something that was only meant to be a note.`,
  },
  {
    slug: 'memory-and-knowledge',
    audience: 'agent',
    title: 'Memory & knowledge',
    summary:
      'The two context tiers (memory and knowledge), recall-first discipline, and the verify-at-recall feedback loop.',
    version: 1,
    body: `## Memory & knowledge

Forge separates durable context into three tiers, each with a different job:

- **Memory** — per-project semantic search over accumulated notes, decisions, fix-patterns, policies. Not auto-loaded into any prompt; you recall it deliberately. \`POST /api/memory/search\` \`{ projectId, query, topK, sourceFilter? }\` returns scored hits; \`POST /api/memory\` \`{ projectId, source, sourceRef, textContent, metadata? }\` upserts on the natural key \`(projectId, source, sourceRef)\` — reusing a \`sourceRef\` refines the existing entry instead of duplicating it.
- **Knowledge** (\`/api/projects/:id/knowledge\`, \`forge knowledge\`) — curated, structured knowledge entries (overview / workflow / rule / reference kinds) with an explicit \`injection\` policy (\`always\` / \`on_demand\` / \`none\`). This is the project's authored knowledge base, distinct from the free-form memory stream.
- **Knowledge with \`injection: always\`** — entries rendered verbatim into every pipeline preamble for this project, as against \`on_demand\`, which reaches the prompt as a slug the agent fetches when it needs the text.

### Recall-first discipline
Before you design, reproduce, or fix something non-trivial: recall what prior work already established for the area you're about to touch, so you neither contradict a settled decision nor rediscover it from scratch. Run one or two focused queries on the concrete nouns of the task — a generic query on the whole project wastes a call and returns noise.

### Verify at recall — the loop that keeps memory clean
A memory hit is point-in-time. Once you've checked it against the live code:
- If it still holds → report \`POST /api/memory/feedback\` with \`{ projectId, source, sourceRef, verdict: 'confirmed' }\`. This protects the entry from decay.
- If it's been superseded → report \`verdict: 'outdated', evidence: '<what disproved it>'\`. This archives it immediately instead of letting the next agent trip over the same stale claim.
A verification you silently do but never report is a cleaning signal thrown away — the entry stays stale for the next reader.

### Capturing a new lesson
Only when it's reusable by a *different* agent on a *different* issue — a convention, a non-obvious gotcha, a fix pattern. Issue-specific detail belongs in that issue's \`sessionContext\`, not memory. Search first (\`sourceFilter: ['knowledge']\`) before writing, to avoid duplicating an existing entry under a different \`sourceRef\`.`,
  },
  {
    slug: 'deploy-safety',
    audience: 'agent',
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
  WHAT_IS_AN_ISSUE_GUIDE,
  WRITING_AN_ISSUE_GUIDE,
  PIPELINE_AND_ISSUE_LIFECYCLE_GUIDE,
  {
    slug: 'attachments-and-uploads',
    audience: 'agent',
    title: 'Attachments & uploads',
    summary:
      'Presigned-URL upload flow vs base64, and how to read the content of an existing attachment.',
    version: 1,
    body: `## Attachments & uploads

### Writing an attachment — presigned URL, not base64
Upload the file from disk instead of inlining base64 bytes into a request: \`forge attach <issue|comment> <id> <file>\`, or a multipart \`POST /api/issues/:id/attachments\` / \`POST /api/comments/:commentId/attachments\` with the file in the \`file\` field. Base64 in a request body is slow to transmit and burns context tokens carrying bytes that don't need to pass through the model at all.

### Reading an attachment's content
\`GET /api/issues/:id/attachments\` lists an issue's attachments (a comment carries its own \`attachments[]\`); \`GET /api/attachments/:id/download\` answers the bytes. Save them to a file and open that file, or read an image as a viewable block with \`forge_uploads\` \`action=fetch\` \`{ target: "issue" | "comment", attachmentId }\`. Never assume a filename or mime type tells you enough; read the content when it matters to the task.`,
  },
  {
    slug: 'agent-setup',
    audience: 'agent',
    title: 'Working in a Forge-managed repo',
    summary:
      'Start here: what Forge owns, the recall-first rule, draft vs open, and the red flags that waste a runner slot.',
    version: 1,
    body: `## Working in a Forge-managed repo

If a repo has a \`.forge/\` directory or an \`mcp.json\` naming a \`forge\` server, its issues, pipeline
and durable memory live in Forge, not in the repo. Read this before your first write.

### The one rule that saves the most time
**Recall before you design.** Project memory is NOT loaded into your context automatically —
\`POST /api/memory/search\` with \`{ projectId, query, topK: 5 }\` is a call you have to make. Skipping it is how
agents rediscover settled decisions, or contradict them. Treat every hit as point-in-time: verify it
against live code or git before you rely on it.

### What Forge owns, and the tool for each
| You need | Call |
|---|---|
| Issues, status, tasks | \`forge issue\`, \`forge new\`, \`forge comment\`; REST \`/api/issues/:id\`, \`/api/issues/:id/comments\`, \`/api/projects/:id/issues\` |
| Ordering between issues | \`relations\` on the create (\`POST /api/projects/:id/issues\`), or \`POST /api/issues/:id/dependencies\` once both exist |
| Repo path, branches, preview URLs, test credentials | \`GET /api/projects/:id\` and \`GET /api/projects/:id/config\` |
| Pipeline gates | \`GET /api/projects/:id/policy\` |
| The project's own prose | \`forge knowledge\` (\`/api/projects/:id/knowledge\`) |
| A decision, learning or convention worth keeping | \`POST /api/memory\` |
| Deeper per-package detail | \`forge knowledge list|get|search\` |
| How a Forge feature actually works | \`forge guide <slug>\`, or \`/api/guides/<slug>.md\` |

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
- **plan-by-hand** — pre-filling \`plan\` or \`acceptanceCriteria\` on create. On a staged project
  those are written by the clarify and plan steps, on an autonomous one by the driver's own
  clarifying and planning phases; filling them deletes that work's reason to exist.
- **wholesale-config-clobber** — writing the policy without reading it first. It is written
  whole against the revision you read; a stale revision is refused, so read, change, send.
- **skip-recall** — see above.
- **fix-by-hand-and-forget** — fixing something outside the pipeline and leaving no status move and
  no recorded learning.

### Writing an issue
Fill \`title\`, \`description\`, \`priority\`, \`category\`. Keep the description a **requirements
contract** — outcome, business rules, invariants, what is out of scope. Not an implementation script
naming files and endpoints: those claims go stale and, in practice, outrank live exploration.`,
  },
  {
    slug: 'module-taxonomy-migration',
    audience: 'agent',
    title: 'Migrating a project onto the module taxonomy',
    summary:
      'Turn an existing module convention — a projectFact list and `**Module:**` comment tags — into kind=module labels and primary attributions, idempotently, without deleting anything.',
    version: 1,
    body: `## Migrating a project onto the module taxonomy

For a project that already names its modules somewhere ELSE — a knowledge entry, a wiki page,
a \`**Module:** billing\` line agents were told to write on every issue — and now wants them as first
class \`kind:"module"\` labels with a primary per issue.

This runs against a DEPLOYED Forge over REST. It is not a repo change, and Forge ships no
command that does it for you: the mapping from an old convention to a taxonomy is a judgement, and
the pass below is the shape that keeps that judgement re-runnable.

### The two idempotency keys
Everything here rests on these. Get them wrong and a second run doubles the data.

| Pass | Key | Already-done test |
|---|---|---|
| Create the module | \`(projectId, label name)\` | a label with that exact name exists — if it is \`kind:"label"\`, PROMOTE it to \`kind:"module"\` rather than creating a second row under a different name |
| Attribute an issue | \`(issueId, labelId, isPrimary)\` | the issue's \`labels[]\` already has that entry with \`isPrimary:true\` |

Label names are not unique in the database. The name is the key **you** are choosing to treat as
one, which is why the promote-don't-duplicate rule above is not optional: create-if-absent keyed on
a name that already exists as a plain label leaves the project with two rows called \`billing\`, and
only one of them can ever be a primary.

### Pass 0 — dry run, reads only
Produce the whole plan before writing anything. Nothing in this pass writes.

1. Read the source of truth for the module list (the knowledge entry, the doc, whatever it is)
   and the project's existing labels (\`GET /api/projects/:id/labels\`).
2. For each intended module, classify it: **absent** (will create), **exists as a plain label**
   (will promote), **exists as a module** (skip).
3. List every issue carrying the old tag. Classify each: **no primary** (will attribute),
   **primary already correct** (skip), **primary is a DIFFERENT module** (do not touch — that is a
   disagreement between the old tag and someone's deliberate choice, and it is a human's to settle).
4. Print the four counts: to-create, to-promote, to-attribute, conflicts. **Read them before the
   write pass.** A to-create count equal to the whole module list on a SECOND run means your name
   key is not matching — stop, do not write.

### Pass 1 — create the modules
Parents before children, so \`parentId\` has something to point at. A module's parent must itself be
a module in the same project, and the hierarchy must stay acyclic; Forge refuses the rest by code
(\`PARENT_NOT_MODULE\`, \`CIRCULAR_HIERARCHY\`, \`INVALID_PARENT\`). A refusal here is information —
it means your source list disagrees with itself. Do not work around it by flattening.

Colour is optional; a module created without one gets a stable colour derived from its name.

### Pass 2 — attribute the issues
For each issue in the to-attribute list, send the label set with the module as an object:

\`\`\`
PATCH /api/issues/:id  { "labels": [{ "labelId": "billing", "isPrimary": true }, ...existing] }
\`\`\`

\`labels\` REPLACES the set — read the issue's current \`labels[]\` and send it back WITH the module
entry, or you will silently strip every other label the issue had. That is the one way this pass
loses data, and it is not the migration doing it, it is a partial payload.

At most one entry may be primary, and it must be a module; both are refused rather than half-applied.

### What this migration must NOT do
- **Do not delete the old tags.** The \`**Module:**\` comment lines stay exactly where they are. They
  become dead weight, not a second source of truth, and leaving them costs nothing while deleting
  them destroys the only record of what the attribution was derived from.
- **Do not clear or re-point a primary somebody set by hand.** Conflicts are reported, not resolved.
- **Do not invent a module for an issue that has no tag.** An issue with no primary is a normal
  state. Forge requires no primary at any status.

### Verify
Re-run pass 0. On a clean migration it reports zero to-create, zero to-promote, zero to-attribute,
and the same conflict list as before. Spot-check one issue per module through
\`GET /api/issues/:id\` → \`labels[]\` and confirm exactly one entry has \`isPrimary:true\`. Then read
the project's issues (\`GET /api/projects/:id/issues\`) and confirm the issues carrying each module
as primary are the ones you attributed and nothing else.

### After the migration
Nothing else to switch on. A project whose labels include a \`kind:"module"\` row gets a
**Module attribution** section in every pipeline agent's system prompt automatically, naming its
modules and the \`isPrimary\` field — so new issues get attributed by the agents that work them, and
the old convention has no second half to maintain. A project with no module labels gets no such
section, which is why this migration is what turns the feature on.`,
  },
  CONFORMANCE_GUIDE,
  ASSISTANT_METHOD_GUIDE,
  RECORDS_GUIDE,
  ECOSYSTEM_INBOX_GUIDE,
  WORKFLOW_DESIGN_GUIDE,
  WORKFLOW_TEMPLATES_GUIDE,
  REQUIREMENT_LIFECYCLE_GUIDE,
  SUGGESTIONS_GUIDE,
  FEEDBACK_TRIAGE_GUIDE,
  RUNS_AND_MASTERS_GUIDE,
] as const;

const GUIDE_BY_SLUG = new Map<string, ForgeGuide>(FORGE_GUIDES.map((g) => [g.slug, g]));

/** Body-free index — slug/title/summary/version only, never guide bodies. */
export function listGuides(): Array<Omit<ForgeGuide, 'body'>> {
  return FORGE_GUIDES.map(({ slug, audience, title, summary, version }) => ({
    slug,
    audience,
    title,
    summary,
    version,
  }));
}

/** Full guide by slug, or `undefined` if unknown. */
export function getGuide(slug: string): ForgeGuide | undefined {
  return GUIDE_BY_SLUG.get(slug);
}
