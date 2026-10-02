// The workflow-design tier of the capability-guide registry: how a master takes a flow from a
// design to code its approver has seen. Same shape, same consumers as registry.ts.
//
// Altitude (NT1): the order of the work and what refuses it. `forge_workflows` carries its schema.

import type { ForgeGuide } from './types.js';

export const WORKFLOW_DESIGN_GUIDE: ForgeGuide = {
  slug: 'workflow-design',
  audience: 'agent',
  title: 'Design a workflow first, build it once it is approved',
  summary:
    'A flow that does not exist yet is drawn as a workflow-v2 design, proposed, and approved by the project owner (or, once the owner says so, by the master) before any issue that builds it is dispatched.',
  version: 3,
  body: `## Design a workflow first, build it once it is approved

A new flow — a storefront journey, a pipeline, a state machine — is drawn before it is built, and its
approver reads the drawing before anyone writes code for it. The kernel holds that order: an issue that
names the workflow it builds is not dispatched while that design is not approved.

### The order of the work
1. **Pick the template, then draw.** Every design names the diagram template it is drawn in,
   \`template: { id, version }\` — \`forge_guide get workflow-templates\` says which (journey-bands for an
   operational journey, state-machine, process-swimlanes, integration-sequence, decision-tree, data-lineage,
   ux-flow for screens). The template fixes the node types, the bands, the fields each type requires and the
   edge kinds. \`forge_workflows action=write\` with a workflow-v2 document (\`GET /api/schemas/workflow-v2.json\`).
   Steps nothing has built yet are \`designed\` and owe no evidence. Give each step its \`node\` (its type,
   a short business \`label\`, a \`purpose\`, and what its type requires) and each line \`after\` draws the
   contract its kind owes. A new v2 workflow is a **draft**.
2. **Propose.** \`action=propose\` with the revision you wrote. The approver now sees it on
   \`/projects/<slug>/workflows/<flow>\` — send them that link.
3. **Wait.** \`action=design\` reads the status: \`proposed\` waits, \`returned\` carries the approver's
   reason, \`approved\` names the revision. A returned design is revised by writing it again, which
   proposes the revision; there is nothing to re-send.
4. **Link the build.** File the issues that build it, then \`action=link\` each one. Until the design is
   approved those issues are out of the admissible list, and a run or job claimed for one is refused
   \`WORKFLOW_DESIGN_NOT_APPROVED\`; \`forge_issues get\` shows why under \`buildsWorkflow\`. Do not link
   the issue the design itself is drawn under, or it waits on itself.
5. **Build the approved revision only.** Build what the approved revision draws. When the code exists,
   refresh the workflow — steps \`current\`, evidence filled — which is a write that does not change the
   design and keeps it approved.

### A loop is a return edge, not a step
\`after\` orders the steps, so a loop in it is refused \`WORKFLOW_AFTER_CYCLE\`. A design whose later step
genuinely returns to an earlier one — an OUTCOME that updates the context so a RULE is evaluated again, a
reopened state — declares that return in \`edges\` with a **return** kind of its template, not in \`after\`,
and never as a renamed copy of the earlier step (that draws two rules where the system has one). In
journey-bands it is \`feedback\`:

\`{ kind: "feedback", from: "outcome", to: "followup-rule", reevaluates: "follow-up rule against the updated context", condition, action, mapping, idempotency, onFailure }\`

- Use it only when the later step's result really re-enters the earlier one. A line forward is a forward
  kind drawn in \`after\`; a return kind whose \`to\` is not a step its \`from\` comes after is refused
  \`WORKFLOW_EDGE_RETURN_FORWARD\`.
- It orders nothing and is outside the cycle check, so it pays with what its kind requires — for
  \`feedback\` the whole contract; anything absent is \`WORKFLOW_EDGE_FIELD_MISSING\`. Idempotency and
  onFailure are what stop a loop running for ever. \`reevaluates\` on a forward kind is
  \`WORKFLOW_EDGE_REEVALUATES_FORWARD\`.
- The canvas draws it as a dashed line curving back, styled by its kind, with its contract on hover.

### What sends a design back to its approver
A write that changes the design — its template, a step added, removed, renamed or re-described, its order,
its node (label and band included), an edge contract, a return edge added or removed — moves an approved design back to \`proposed\`, and its linked issues stop dispatching
until it is approved again. The approved revision stays readable, so the approver sees what changed.
Status, evidence and coverage are the code's reading of itself and move nothing.

### Evidence follows the project's source
A storefront project has no repository: its evidence is the provider's artefact,
\`{ kind: "storefront", provider, ref: workflow | route | node, id }\` — an Autoflow workflow code, route
or node id. A repository project cites \`{ kind: "repo", file, coverage }\`. The other kind is refused
\`WORKFLOW_EVIDENCE_KIND_MISMATCH\`.

### Who approves
The project document's \`workflows.designApprover\` decides. \`owner\` (the default) is an org admin
person: an agent deciding is refused \`WORKFLOW_DESIGN_APPROVER_NOT_PERSON\`. Once the owner sets
\`master\`, this project's own master may approve too — never another project's agent
(\`WORKFLOW_DESIGN_APPROVER_NOT_PROJECT\`). Unlinking an issue lifts its gate, so only the approver may.`,
};
