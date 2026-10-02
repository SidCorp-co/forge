// The workflow-templates tier of the capability-guide registry: which diagram template an agent
// builder draws a design in, and what each one holds it to. Same shape, same consumers as registry.ts.
//
// The vocabulary tables are rendered from the built-in registry itself, so the guide cannot list a
// node type, a required field or an edge kind the kernel does not hold; only the choice table and
// the sketches are written by hand, and `workflow-templates-guide.test.ts` holds a sketch to every
// built-in.

import {
  BUILTIN_WORKFLOW_TEMPLATES,
  TEMPLATE_RULE_MEANING,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import type { ForgeGuide } from './types.js';

/** What the agent builder is drawing, and the template that draws it. */
export const TEMPLATE_CHOICES: readonly [string, string][] = [
  [
    'an operational journey: an event, the facts read, rules that decide, a case and tasks people work, the result and the feedback that re-checks the rules',
    'journey-bands',
  ],
  [
    'the statuses one thing moves through and the guarded moves between them (issue lifecycle, order status, approval)',
    'state-machine',
  ],
  [
    'who does what in a business process, one lane per actor, with gateways and start/end events',
    'process-swimlanes',
  ],
  [
    'how systems exchange messages in time order (HIS → HOP), with mapping, idempotency and failure per message',
    'integration-sequence',
  ],
  ['how one decision is reached: questions, branches and rule tables with tests', 'decision-tree'],
  [
    'where data comes from and goes: sources, transforms, stores, consumers, with field mappings',
    'data-lineage',
  ],
  [
    'what a person sees and does on screen: screens, their states, actions, and the business steps submits drive',
    'ux-flow',
  ],
];

/** The shape each built-in draws, small enough to read at a glance. */
export const TEMPLATE_SKETCHES: Readonly<Record<string, string>> = {
  'journey-bands': `Trigger     [EVENT]
              │
Understand  [CONTEXT]
              │
Decide      [RULE] → [STATE] → [EXPECTATION]
              ▲                    │
Organise    ┆                  [CASE] → [TASK] ┄┄escalation┄┄▶ [ATTENTION]
Act         ┆                             [ACTION]
Result      ┆                             [OUTCOME]
Feedback    └┄┄┄┄┄┄ re-evaluate ┄┄┄┄┄┄┄┄┄ [RULE]
Close                                     [OUTCOME]`,
  'state-machine': `(● placed) ──payment captured──▶ (paid) ──label printed──▶ (shipped) ──▶ (◎ delivered)
     ▲                                                   ┆
     └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ back: charged back ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘`,
  'process-swimlanes': `Employee │ (▶ ask) ┄┄message┄┄┐                      ┌──▶ (■ told)
Manager  │                     ◇ approve? ──┐          │
HR       │                                  └──▶ [record leave]`,
  'integration-sequence': `HIS │ [SEND discharge] ──message (mapping · idempotency · onFailure)──┐
HOP │                                   [RECEIVE] ··▶ [STORE] ··▶ [RESPOND 202]`,
  'decision-tree': `◇ surgery? ──had surgery──▶ ▦ urgency table (vip → 4h · else 24h)
            └─no surgery──▶ ✓ no call`,
  'data-lineage': `Sources     Transforms     Stores        Consumers
[events] ──▶ [daily roll-up] ──▶ [ops mart] ──▶ [dashboard]
     (every hop carries its field mapping)`,
  'ux-flow': `Arrive    [▭ Patient card] ┄┄error┄┄▶ ⚠ could not load
               │
Interact  [☝ pick slot]
               │ submit (payload · success · failure)
System    [⚙ book → invokes post-discharge/call]
               ├──────────────▶ Result [▭ Booked]
               └┄┄error┄┄▶ Result ⚠ slot taken`,
};

const code = (s: string) => `\`${s}\``;

function vocabulary(t: WorkflowTemplate): string {
  const lanes =
    t.lanes.from === 'template'
      ? `**Bands** (top to bottom): ${t.lanes.bands.map((b) => `${b.label} ${code(b.id)} — ${b.types.join(', ')}`).join(' · ')}`
      : t.lanes.from === 'design'
        ? `**Lanes:** declared by the design, one per ${t.lanes.noun}: ${code('lanes: [{ id, label }]')}, and every step names its lane in ${code('node.band')}.`
        : '**Not banded:** no step names a band.';
  const types = t.nodeTypes
    .map(
      (n) =>
        `| ${code(n.id)} | ${n.label} | ${n.required.length ? n.required.map(code).join(', ') : '—'} | ${n.band ? code(n.band) : '—'} |`,
    )
    .join('\n');
  const kinds = t.edgeKinds
    .map(
      (k) =>
        `| ${code(k.id)}${k.id === t.defaultEdgeKind ? ' (default)' : ''} | ${k.direction} | ${k.required.length ? k.required.map(code).join(', ') : '—'} | ${k.fromTypes ? k.fromTypes.join(', ') : 'any'} → ${k.toTypes ? k.toTypes.join(', ') : 'any'} |`,
    )
    .join('\n');
  return `### ${t.title} — ${code(`${t.id}@${t.version}`)}
${t.purpose}

\`\`\`
${TEMPLATE_SKETCHES[t.id] ?? ''}
\`\`\`

Layout ${code(t.layout.family)}, ${t.layout.direction}. ${lanes}${t.defaultNodeType ? ` A step with no ${code('node')} is a ${code(t.defaultNodeType)}.` : ''}

| Node type | Reads as | Required fields | Home band |
|---|---|---|---|
${types}

| Edge kind | Direction | Required fields | From → to |
|---|---|---|---|
${kinds}

Rules:
${t.rules.map((r) => `- ${code(r)}: ${TEMPLATE_RULE_MEANING[r]}.`).join('\n')}`;
}

const BODY = `## Pick a diagram template, then draw the design in it

Every workflow-v2 design names the template it is drawn in — ${code('template: { id, version }')} — and the
kernel checks it against that template: the node types it may use, the band each step sits in, the fields
each type owes, the edge kinds and what each carries, and the template's rules. The canvas draws it from the
template too, so the right template is also how the approver sees it right.

${code('forge_workflows action=templates')} lists what this project may draw in (the built-ins, then its own);
${code('action=template { templateId, templateVersion }')} returns one with a tiny example design that passes.
Public, no credential: ${code('GET /api/workflow-templates')}, ${code('GET /api/workflow-templates/<id>/<version>')},
the meta-schema ${code('GET /api/schemas/workflow-template-v1.json')}. A project's own: ${code('GET /api/projects/<id>/workflow-templates')}.

### Which template

| You are drawing | Use |
|---|---|
${TEMPLATE_CHOICES.map(([what, id]) => `| ${what} | ${code(id)} |`).join('\n')}

Unsure between two? Draw what the approver will ask about: "who does it" → swimlanes, "what state is it in"
→ state-machine, "what does the business decide and who works it" → journey-bands, "what does the person see"
→ ux-flow. One flow, one template; a UX flow and the business journey it drives are two designs, linked by
${code('invokes')}.

### Business words on the canvas
The canvas shows what the design says and invents nothing. Give each step's node a short ${code('label')} (the
card title; absent, the step ${code('title')}) and a ${code('purpose')} (the one sentence under it), and each
edge a ${code('label')} (absent, its ${code('condition')}). Write them in the approver's words, not the code's.

${BUILTIN_WORKFLOW_TEMPLATES.map(vocabulary).join('\n\n')}

### Designing a UI/UX flow
- **ux-flow or journey-bands?** journey-bands is what the business does with a case — rules, owners, SLAs.
  ux-flow is what one person sees and does on screen. A booking screen is ux-flow; the follow-up rule and the
  coordinator's task it feeds are journey-bands. Draw both when both matter, as two designs.
- **Link screens to business steps.** Every ${code('SYSTEM_STEP')} names ${code('invokes: { workflow, step }')} —
  a step of another design this project holds (e.g. the journey's ${code('TASK')} "call"). It is resolved when
  you write: a design or step that does not exist, or this same design, is ${code('WORKFLOW_TEMPLATE_RULE')}
  (invokes-resolve). Write the business design first.
- **Personas** are declared once on the design, ${code('personas: [{ id, label }]')}, and each ${code('SCREEN')}
  names one in ${code('node.persona')}; an undeclared one is refused (personas-declared).
- **Every screen can fail.** Draw an ${code('error')} edge from it to a ${code('UI_STATE')} of variant
  ${code('error')} (variants: empty, loading, error, permission-denied), or say why it cannot in
  ${code('node.noErrorState')} (screen-error-state).
- **Every submit lands somewhere.** A ${code('submit')} edge runs from a ${code('USER_ACTION')} to a
  ${code('SYSTEM_STEP')} and carries ${code('payload')}, ${code('success')} and ${code('failure')} — the steps the
  person reaches either way (submit-targets).
- **Wireframes.** The assistant can draw each screen as a wireframe-v1 board and attach it to the issue
  (${code('<name>.wireframe.json')} plus its SVG). Name it on the screen as
  ${code('node.wireframe: { attachment: <json attachment id>, svg: <svg attachment id> }')}; the canvas shows the
  SVG as the screen's thumbnail.

### Refusals and their fix
| Refused | Means | Fix |
|---|---|---|
| ${code('WORKFLOW_TEMPLATE_MISSING')} | the v2 document names no template | add ${code('template: { id, version }')} |
| ${code('WORKFLOW_TEMPLATE_UNKNOWN')} | no such template, or not that version | pick one from ${code('action=templates')} |
| ${code('WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE')} | a node type the template does not declare | use one of its types, or extend the template |
| ${code('WORKFLOW_NODE_FIELD_MISSING')} | a type's required field is absent or empty | fill the fields the refusal names |
| ${code('WORKFLOW_BAND_MISMATCH')} | a step in no band, an unknown band, or a band that does not admit its type | set ${code('node.band')} to a band that admits it |
| ${code('WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE')} | an edge kind the template does not declare | use one of its kinds |
| ${code('WORKFLOW_EDGE_FIELD_MISSING')} | an edge (or an ${code('after')} line of a kind that owes fields) lacks what its kind requires | add the edge entry with those fields |
| ${code('WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND')} | a kind joining types it does not join (a ${code('navigate')} into a UI_STATE) | use the kind the refusal names |
| ${code('WORKFLOW_EDGE_RETURN_FORWARD')} | a return kind that does not go back | make it a forward line in ${code('after')} |
| ${code('WORKFLOW_EDGE_REEVALUATES_FORWARD')} | ${code('reevaluates')} on a forward kind | only a return kind re-evaluates |
| ${code('WORKFLOW_TEMPLATE_RULE')} | one of the template's rules is broken; the detail names it | as the detail says |

### A template of the project's own
A project whose diagrams none of these draw declares its own in the project document,
${code('workflows.templates')} (${code('PUT /api/projects/<id>/config')}), checked by the same meta-schema:
- **Extend a built-in** (most cases): ${code('{ $schema, id: "<new id>", version: 1, title, purpose, extends: { id: "journey-bands", version: 1 }, nodeTypes?, edgeKinds?, bands?, bandTypes?: { <band>: [<types>] }, rules? }')}.
  It only adds; re-declaring a base type, kind or band is ${code('WORKFLOW_TEMPLATE_EXTENSION_OVERRIDES')}.
- **A complete template** has every field a built-in has.
- Its id is its own — a built-in's id is ${code('WORKFLOW_TEMPLATE_ID_TAKEN')}; ${code('id@version')} twice is
  ${code('WORKFLOW_TEMPLATE_DUPLICATE')}; a type, band or kind it names but does not declare is
  ${code('WORKFLOW_TEMPLATE_INVALID')}. A changed template is a new version; one a stored design is drawn in
  cannot be removed (${code('WORKFLOW_TEMPLATE_IN_USE')}).
- **Propose before you write it**: writing the project document takes project admin, and a template changes
  how every design drawn in it is checked. Draft the template, show the owner one design drawn in it, and
  write it once they agree. HOP needs nothing custom: ${code('journey-bands')} is its template.`;

export const WORKFLOW_TEMPLATES_GUIDE: ForgeGuide = {
  slug: 'workflow-templates',
  audience: 'agent',
  title: 'Pick a diagram template for a workflow design',
  summary:
    'Every workflow-v2 design names a diagram template — journey-bands, state-machine, process-swimlanes, integration-sequence, decision-tree, data-lineage, ux-flow or a project template — which fixes its node types, bands, edge kinds and required fields. Which to pick, what each holds a design to, and how each refusal is fixed.',
  version: 1,
  body: BODY,
};
