// The workflow-design tier of the capability-guide registry: how a master takes a flow from a
// design to code its approver has seen. Same shape, same consumers as registry.ts.
//
// Altitude (NT1): the order of the work and what refuses it. `GET /api/schemas/workflow-v2.json` carries its schema.

import type { CoreGuide } from './types.js';

export const WORKFLOW_DESIGN_GUIDE: CoreGuide = {
  slug: 'workflow-design',
  audience: 'agent',
  title: 'Design a workflow first, build it once it is approved',
  summary:
    'A flow that does not exist yet is drawn as a workflow-v2 design, proposed, and approved by a holder of workflow-designs.approve before any issue that builds it is dispatched.',
  version: 5,
  body: `## Design a workflow first, build it once it is approved

A new flow — a storefront journey, a pipeline, a state machine — is drawn before it is built, and its
approver reads the drawing before anyone writes code for it. The kernel holds that order: an issue that
names the workflow it builds is not dispatched while that design is not approved.

### The order of the work
1. **Pick the template, then draw.** Every design names the diagram template it is drawn in,
   \`template: { id, version }\` — \`GET /api/guides/workflow-templates.md\` says which (operational-flow for
   what the business does, service-blueprint, ux-flow for screens, state-machine, integration-sequence,
   decision-model, data-flow, system-context). The template fixes the node types, the bands, the fields each
   type requires, the edge kinds and the cross-links to the project's other designs. \`POST /api/projects/:id/workflows\` creates one with a workflow-v2 document (\`GET /api/schemas/workflow-v2.json\`), \`PUT …/workflows/:workflow\` with the \`baseRevision\` you read writes the next revision. A PUT takes what GET returned as it stands: \`revision\` is the base, and \`writer\`, \`writerName\`, \`design\` and the document's \`id\`, \`createdAt\` and \`updatedAt\` are the server's, dropped and listed in the answer's \`ignored\`.
   A design holds the plan only: no step status, evidence or commit. Give each step its \`node\` (its type,
   a short business \`label\`, a \`purpose\`, and what its type requires) and each line \`after\` draws the
   contract its kind owes. A new v2 workflow is a **draft**.
2. **Propose.** \`POST …/workflows/:workflow/design/propose\` with the revision you wrote and \`issue\`, the issue the design is
   drawn under. A later write that proposes again names it with \`issue\` beside \`baseRevision\`; without one it
   inherits the superseded revision's issue while that issue is still work, and once that issue is closed or dropped
   the write is refused \`WORKFLOW_DESIGN_ISSUE_REQUIRED\` until it names one. The approver now sees it on
   \`/projects/<slug>/workflows/<flow>\` — send them that link.
3. **Wait.** The decision wakes this project's master. \`GET …/workflows/:workflow/design\` reads the status: \`proposed\`
   waits, \`returned\` carries the approver's reason, \`approved\` names the revision. An approval may
   carry its approver's note on that revision's \`reason\` — the conditions it was given under, such as a
   revision still owed or a deviation accepted — so read it before linking or building, and a build job is
   given it with the approved revision. An approval records the revision as the landing of the issue it was
   drawn under — its merged mark is written, or re-pointed from a revision only proposed — and moves no
   status: that issue's run, or the release that claims it, takes its next move. A return reopens
   the design's issue with the reason posted on it, and \`GET /api/issues/:id\` shows it under
   \`proposesWorkflow\`, so the issue is admissible work again; a design issue standing at a park keeps
   its park and only gets the reason posted. **To park an issue until the approver decides**, park it at
   \`needs_info\` with \`awaitsDesign: { workflowId, revision }\` naming the revision now waiting: the
   decision, approve or return, is written as the answer to the question that park asks, and the issue
   moves back to the status it left as any answer moves it. A park naming any other revision is refused
   \`QUESTION_DESIGN_UNKNOWN\` or \`QUESTION_DESIGN_NOT_AWAITING\`; a park asked in prose alone stays open
   after the approval until a person answers it too. Writing a new revision while one is still waiting
   voids the questions on the old one and asks each issue again of the new one. A return no live issue carries is the
   master's own work: core counts it every time the master's box sweeps, and names it on the pass until
   the next revision is proposed. A returned design is revised by writing it again, which
   proposes the revision; there is nothing to re-send.
4. **Link the build.** File the issues that build it, then link each one (\`POST …/workflows/:workflow/builds\`). Until the design is
   approved those issues are out of the admissible list, and a run or job claimed for one is refused
   \`WORKFLOW_DESIGN_NOT_APPROVED\`; \`GET /api/issues/:id\` shows why under \`buildsWorkflow\`. Linking
   the issue the design itself is drawn under is refused \`WORKFLOW_DESIGN_ISSUE_IS_BUILD\`: it would wait
   on itself.
5. **Build the approved revision only.** Build what the approved revision draws. What the code holds is
   then read into an **observation** — \`POST /api/projects/:id/workflows/:workflow/observations\` with the
   commit read (\`atSha\`), each observed step naming the planned step
   it \`matches\` (or null) and citing \`{ kind: "repo", file, symbol }\`. It is stored apart and never
   touches the design or its approval. Only a rooted design is observed — an approved revision and at
   least one linked requirement, else \`WORKFLOW_OBSERVATION_UNROOTED\` — and only against its approved
   revision (\`WORKFLOW_OBSERVATION_REVISION_NOT_APPROVED\`). The commit must be on the landing branch
   (\`WORKFLOW_OBSERVATION_COMMIT_OFF_BRANCH\`) and every cited file and symbol must exist there
   (\`WORKFLOW_OBSERVATION_CITATION_MISSING\`); an uncited node is \`WORKFLOW_OBSERVATION_UNCITED\`, and a repository Forge cannot read
   \`WORKFLOW_OBSERVATION_SOURCE_UNREADABLE\`. Writing one takes \`workflow-observations.write\`; a
   token whose grant names it is an observer credential and never holds \`workflow-designs.write\` or
   \`workflow-designs.approve\`, so the agent that reads the code cannot change the design it reads. The
   observation records who wrote it and their agency; one is kept per commit.
6. **Decide each marked node.** A workflow decision comment carrying \`decision.node\` (a step or an edge,
   \`verdict\` keep | rewrite | delete, \`layer\` planned or observed, the \`marker\` it carried) names a
   node of the approved revision, or with \`layer: "observed"\` a node of the latest observation, else
   \`WORKFLOW_NODE_UNKNOWN\`. Posting one takes \`workflow-designs.approve\`.

### A loop is a return edge, not a step
\`after\` orders the steps, so a loop in it is refused \`WORKFLOW_AFTER_CYCLE\`. A design whose later step
genuinely returns to an earlier one — an OUTCOME that updates the context so a RULE is evaluated again, a
reopened state — declares that return in \`edges\` with a **return** kind of its template, not in \`after\`,
and never as a renamed copy of the earlier step (that draws two rules where the system has one). In
operational-flow it is \`feeds-back\`:

\`{ kind: "feeds-back", from: "outcome", to: "context", reevaluates: "the patient context the rule reads", payload, idempotency, onFailure }\`

- Use it only when the later step's result really re-enters the earlier one. A line forward is a forward
  kind drawn in \`after\`; a return kind whose \`to\` is not a step its \`from\` comes after is refused
  \`WORKFLOW_EDGE_RETURN_FORWARD\`.
- It orders nothing and is outside the cycle check, so it pays with what its kind requires — for
  \`feeds-back\` the whole contract; anything absent is \`WORKFLOW_EDGE_FIELD_MISSING\`. Idempotency and
  onFailure are what stop a loop running for ever. \`reevaluates\` on a forward kind is
  \`WORKFLOW_EDGE_REEVALUATES_FORWARD\`.
- The canvas draws it as a dashed line curving back, styled by its kind, with its contract on hover.

### A design built on another declares it
A design that builds on another design of the project — a state machine over an audit layer's steps, a
decision model's permissions — names it in \`basedOn: [{ workflow: <flow>, revision: <n> }]\`, the revision
it builds on. A base naming the design itself, a flow the project does not hold, a revision that workflow
never held, or one flow twice is refused at the write (\`WORKFLOW_BASE_SELF\`, \`WORKFLOW_BASE_UNKNOWN\`,
\`WORKFLOW_BASE_DUPLICATE\`). Approving a revision is refused \`WORKFLOW_DESIGN_BASE_UNAPPROVED\` while any
base it declares is not approved at the revision it names — returned, still proposed, never approved, or
approved at another revision — and the refusal names each base and its state. The same reading stands
before anyone tries: a proposed design whose base moved reads as waiting on its writer to re-pin \`basedOn\`,
not on its approver. Approve the base first, or write the design again naming the base revision that is approved. Prose that cites another design is
never read as a base.

An issue that delivers a design revision — the issue the revision is drawn under, or one whose criteria
are judged against a design revision — holds the issues it \`blocks\` until that revision is approved,
whatever its own status: proposing the design moves the issue on, and only the approval releases its
dependents.

### What sends a design back to its approver
A write that changes the design — its template, a step added, removed, renamed or re-described, its order,
its node (label and band included), an edge contract, a return edge added or removed, its \`basedOn\` — moves an approved design back to \`proposed\`, and its linked issues stop dispatching
until it is approved again. The approved revision stays readable, so the approver sees what changed.
An observation of the code moves nothing.

### An observation cites the project's source
A storefront project has no repository: an observed node cites the provider's artefact,
\`{ kind: "storefront", provider, ref: workflow | route | node, id }\` — an Autoflow workflow code, route
or node id. A repository project cites \`{ kind: "repo", file, symbol }\`. The other kind is refused
\`WORKFLOW_OBSERVATION_CITATION_KIND_MISMATCH\`.

### Who approves
Whoever holds \`workflow-designs.approve\` on the project (project admin, or an org owner or admin),
person or agent alike, a design onboarding drafted included; without it the call is refused
\`PERMISSION_FORBIDDEN\` naming the permission. Unlinking an issue lifts its gate, so it takes the
same permission. The project document's old \`workflows.designApprover\` is retired, and a write naming
it is refused \`APPROVER_POLICY_RETIRED\`.`,
};
