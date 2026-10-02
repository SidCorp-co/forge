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
  type TemplateNodeType,
  type WorkflowTemplate,
} from '@forge/contracts/workflow-templates';
import type { ForgeGuide } from './types.js';

/** What the agent builder is drawing, and the template that draws it. */
export const TEMPLATE_CHOICES: readonly [string, string][] = [
  [
    'what the business does when an event happens: the source, the context read, the rules that decide, the case and tasks people work, what they do, the outcome and the feedback',
    'operational-flow',
  ],
  [
    'what a patient or customer goes through and the staff and systems behind it, either side of the line of visibility (journey and patient maps)',
    'service-blueprint',
  ],
  [
    'a process across roles you name, one lane per role, with gateways and waits (swimlane, BPMN-lite, UML activity)',
    'service-blueprint-cross-functional',
  ],
  [
    'what a person sees and does on screen: entry, screens and their states, actions, system responses, exit',
    'ux-flow',
  ],
  [
    'the states one thing moves through and the events and guards that move it (case, task, attention item)',
    'state-machine',
  ],
  ['the same, where each state is a FHIR R4 Task.status code', 'state-machine-fhir-task'],
  ['the same, where each state is a FHIR R4 Encounter.status code', 'state-machine-fhir-encounter'],
  [
    'the calls between systems in order (HIS → HOP), sync or async, with idempotency and the failure path',
    'integration-sequence',
  ],
  [
    'how one decision is reached: its table of conditions, the data it takes, the policy behind it',
    'decision-model',
  ],
  [
    'where patient data goes: source systems, datasets and their owners, processes, outside parties, inside trust boundaries',
    'data-flow',
  ],
  [
    'where the product sits among its users and systems (C4 levels 1–2): the master list of systems the others name',
    'system-context',
  ],
];

const MACHINE = `(▶) ──case.opened──▶ (Open) ──accepted──▶ (In progress) ──outcome.recorded──▶ (◎ Closed)
                       ▲                     ┆
                       └┄┄┄┄ back: needs.more_info ┄┄┄┄┘`;

/** The shape each built-in draws, small enough to read at a glance. */
export const TEMPLATE_SKETCHES: Readonly<Record<string, string>> = {
  'operational-flow': `Trigger     [SOURCE] ──emits──▶ [EVENT]
Understand  [CONTEXT] ┈┈enriches┈┈┐    │ evaluates
Decide                        └─▶ [RULE] → [STATE] → [EXPECTATION]
Organise                      [CASE] → [TASK]        ┆ breaches
Act                                   [ACTION]   [ATTENTION]
Result                                [OUTCOME]
Feedback    ▲┄┄┄┄┄┄┄┄┄ feeds-back ┄┄┄┄┄┄┄┄┄┘ (to CONTEXT, STATE or RULE)`,
  'service-blueprint': `Evidence    [reminder msg]
Patient     [books a slot] ────────────────┐      line of interaction
Frontstage  [Zalo reminder]   [booking confirmed]   line of visibility
Backstage                       [schedule the call]   line of internal interaction
Support                           [HIS appointment]`,
  'service-blueprint-cross-functional': `Coordinator │ [take referral] ┄┄handoff┄┄┐
Nurse       │                            └──▶ [review referral]`,
  'ux-flow': `(▶ link) ──▶ [▭ Pick a time] ┄┄shows┄┄▶ ⚠ loading · empty · error
                     │
                  [☝ Book this slot] ──▶ [⚙ save booking] ──returns──▶ [▭ Booked] ──▶ (■ done)`,
  'state-machine': MACHINE,
  'state-machine-fhir-task': `${MACHINE}
 mapsTo: requested · in-progress · completed`,
  'state-machine-fhir-encounter': `${MACHINE}
 mapsTo: planned · in-progress · finished`,
  'integration-sequence': `HIS ──async: ADT^A03──▶ [message] ──reply──▶ [ACK] ◀── HOP
 (every participant is a SYSTEM or CONTAINER of system-context)`,
  'decision-model': `[input: episode risk] ──▶ ◇ Follow-up needed ◀┈┈governed by┈┈ [policy]
                          ▦ high → 48h · medium → 7 days · low → none`,
  'data-flow': `Hospital │ [HIS] ──reads──▶
HOP      │        [ingest] ──writes──▶ [Episodes] ──reads──▶ [reminders]
Outside  │                                        ──publishes──▶ [Zalo]`,
  'system-context': `Hospital │ [HIS] ◀──reads-from (HL7v2)──┐
HOP      │ (coordinator) ──uses──▶ [HOP app]
Outside  │ [Zalo] ◀──writes-to (OA API)──┘`,
};

const code = (s: string) => `\`${s}\``;

function shapeOf(n: TemplateNodeType): string {
  const lines = (side: 'in' | 'out') =>
    (n.lines?.[side] ?? []).map(
      (r) =>
        `${side} ${r.kind ?? 'any'} ${r.max === r.min ? r.min : `${r.min}${r.max === undefined ? '+' : `–${r.max}`}`}`,
    );
  const parts = [
    n.entry ? 'entry' : '',
    n.count ? `${n.count.min ?? 0}–${n.count.max ?? 'n'} per design` : '',
    ...lines('in'),
    ...lines('out'),
    n.unique ? `unique ${n.unique.join(', ')}` : '',
    n.vocabulary ? `mapsTo ∈ ${n.vocabulary.join(' · ')}` : '',
    ...(n.links ?? []).map(
      (l) => `${l.required ? 'links' : 'may link'} → ${l.template} ${l.types.join('/')}`,
    ),
  ].filter(Boolean);
  return parts.length ? parts.join('; ') : '—';
}

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
        `| ${code(n.id)} | ${n.label} | ${n.required.length ? n.required.map(code).join(', ') : '—'} | ${n.band ? code(n.band) : '—'} | ${shapeOf(n)} |`,
    )
    .join('\n');
  const kinds = t.edgeKinds
    .map(
      (k) =>
        `| ${code(k.id)}${k.id === t.defaultEdgeKind ? ' (default)' : ''} | ${k.direction} | ${k.required.length ? k.required.map(code).join(', ') : '—'} | ${k.fromTypes ? k.fromTypes.join(', ') : 'any'} → ${k.toTypes ? k.toTypes.join(', ') : 'any'} |`,
    )
    .join('\n');
  return `### ${t.title} — ${code(`${t.id}@${t.version}`)}${t.presetOf ? ` (a preset of ${code(t.presetOf)})` : ''}
${t.purpose}

\`\`\`
${TEMPLATE_SKETCHES[t.id] ?? ''}
\`\`\`

Layout ${code(t.layout.family)}, ${t.layout.direction}. ${lanes}${t.defaultNodeType ? ` A step with no ${code('node')} is a ${code(t.defaultNodeType)}.` : ''}

| Node type | Reads as | Required fields | Home band | Shape |
|---|---|---|---|---|
${types}

| Edge kind | Direction | Required fields | From → to |
|---|---|---|---|
${kinds}

Rules:
${t.rules.map((r) => `- ${code(r)}: ${TEMPLATE_RULE_MEANING[r]}.`).join('\n')}`;
}

const REFUSALS: readonly [string, string, string][] = [
  [
    'WORKFLOW_TEMPLATE_MISSING',
    'the v2 document names no template',
    'add `template: { id, version }`',
  ],
  [
    'WORKFLOW_TEMPLATE_UNKNOWN',
    'no such template, or not that version',
    'pick one from `action=templates`',
  ],
  [
    'WORKFLOW_NODE_TYPE_NOT_IN_TEMPLATE',
    'a node type the template does not declare',
    'use one of its types, or extend the template',
  ],
  [
    'WORKFLOW_NODE_FIELD_MISSING',
    "a type's required field is absent or empty",
    'fill the fields the refusal names',
  ],
  [
    'WORKFLOW_NODE_VALUE_NOT_IN_VOCABULARY',
    '`mapsTo` outside the closed set a preset declares',
    'use one of the codes the refusal lists',
  ],
  [
    'WORKFLOW_BAND_MISMATCH',
    'a step in no band, an unknown band, or a band that does not admit its type',
    'set `node.band` to a band that admits it',
  ],
  [
    'WORKFLOW_NODE_NOT_ENTRY',
    'a step comes after nothing and is not an entry type',
    'list what it comes after; only an entry type starts the flow',
  ],
  [
    'WORKFLOW_NODE_TYPE_COUNT',
    'too few or too many steps of a type (no EXIT, two INITIALs)',
    'add or remove steps of that type',
  ],
  [
    'WORKFLOW_NODE_LINES',
    'a step lacks a line its type owes, or has too many (an EVENT two sources emit, an OUTCOME that does not feed back)',
    'draw or remove the line the refusal names',
  ],
  [
    'WORKFLOW_NODE_FIELD_NOT_UNIQUE',
    'two steps of a type share a value that is unique (two screens on one route)',
    'give each its own value',
  ],
  [
    'WORKFLOW_EDGE_KIND_NOT_IN_TEMPLATE',
    'an edge kind the template does not declare',
    'use one of its kinds',
  ],
  [
    'WORKFLOW_EDGE_KIND_NONE',
    'no kind of the template joins these two node types',
    'change a step type, or route the line through a step that joins them',
  ],
  [
    'WORKFLOW_EDGE_KIND_AMBIGUOUS',
    "a line's endpoint types fit more than one kind",
    'name its `kind` in `edges`',
  ],
  [
    'WORKFLOW_EDGE_FIELD_MISSING',
    'an edge, or an `after` line of a kind that owes fields, lacks what its kind requires',
    'add the edge entry with those fields',
  ],
  [
    'WORKFLOW_EDGE_ENDPOINT_NOT_IN_KIND',
    'a named kind joining types it does not join',
    'use the kind the refusal names',
  ],
  [
    'WORKFLOW_EDGE_RETURN_FORWARD',
    'a return kind that does not go back',
    'make it a forward line in `after`',
  ],
  [
    'WORKFLOW_EDGE_REEVALUATES_FORWARD',
    '`reevaluates` on a forward kind',
    'only a return kind re-evaluates',
  ],
  [
    'WORKFLOW_REF_NOT_ALLOWED',
    'a ref to a template the node type does not link to',
    'link only where its type says it may',
  ],
  [
    'WORKFLOW_REF_DANGLING',
    'a ref to a design or step the project does not hold, or a write that removes a step another design links to',
    'draw the target first, or change the linking design first',
  ],
  [
    'WORKFLOW_REF_TARGET_MISMATCH',
    'the target is drawn in another template, or is a type the link does not take',
    'point at a step of the type the refusal names',
  ],
  [
    'WORKFLOW_REF_MISSING',
    'a type that must link carries no ref (a PARTICIPANT with no system)',
    'add `refs: [{ template, flow, step }]`',
  ],
  [
    'WORKFLOW_TEMPLATE_RULE',
    "one of the template's rules is broken; the detail names it",
    'as the detail says',
  ],
];

const BODY = `## Pick a diagram template, then draw the design in it

Every workflow-v2 design names the template it is drawn in — ${code('template: { id, version }')} — and the
kernel checks it against that template: the node types it may use, the band each step sits in, the fields
each type owes, the lines each type owes, the edge kinds and what each carries, the cross-links to the
project's other designs, and the template's rules. The canvas draws it from the template too, so the right
template is also how the approver sees it right.

${code('forge_workflows action=templates')} lists what this project may draw in (the built-ins, then its own);
${code('action=template { templateId, templateVersion }')} returns one with a small example design that passes.
Public, no credential: ${code('GET /api/workflow-templates')}, ${code('GET /api/workflow-templates/<id>/<version>')},
the meta-schema ${code('GET /api/schemas/workflow-template-v1.json')}. A project's own: ${code('GET /api/projects/<id>/workflow-templates')}.

### Which template

| You are drawing | Use |
|---|---|
${TEMPLATE_CHOICES.map(([what, id]) => `| ${what} | ${code(id)} |`).join('\n')}

Unsure between two? Draw what the approver will ask about: "what does the business do when X happens" →
operational-flow, "what does the patient go through" → service-blueprint, "what does the person see" →
ux-flow, "what state is it in" → state-machine. One flow, one template; a screen flow and the business flow it
drives are two designs, linked by refs. A preset is a template of its own whose ${code('presetOf')} names the
one it varies; a link to that one reaches a design drawn in the preset too.

### Business words on the canvas
The canvas shows what the design says and invents nothing. Give each step's node a short ${code('label')} (the
card title; absent, the step ${code('title')}) and a ${code('purpose')} (the one sentence under it), and each
edge a ${code('label')} (absent, its ${code('condition')}). Write them in the approver's words, not the code's.

### Lines and their kinds
A line is drawn by ${code('after')}, and its kind is read from its endpoint types: the one forward kind whose
${code('fromTypes')}/${code('toTypes')} admit both ends (a kind that names types beats one that names none; left
with several, the template's default, else you name it). An ${code('edges')} entry carries the line's contract —
the fields its kind requires — and names ${code('kind')} only where the endpoints do not decide it. A return
kind (${code('feeds-back')}, ${code('back')}) is never in ${code('after')}: it is an ${code('edges')} entry from the later step
to the earlier one, so it orders nothing and is outside the cycle check.

### Cross-links between designs
A node may carry ${code('refs: [{ template, flow, step }]')} — the step of another design of this project it
is: a USER_ACTION to the operational-flow EVENT or ACTION it triggers, a RULE to its decision-model DECISION,
a PARTICIPANT or SOURCE_SYSTEM to its system-context SYSTEM. Its node type's ${code('links')} say which
templates and types it may link to, and which it must (the Shape column below). Both ends are held when you
write: a ref must resolve to a step of the right type in a design drawn in that template, and a write may not
remove or retype a step another design links to. So draw what is linked to first — system-context before
integration-sequence and data-flow, the operational flow before the screens that trigger it.

${BUILTIN_WORKFLOW_TEMPLATES.map(vocabulary).join('\n\n')}

### Designing a UI/UX flow
- **ux-flow or operational-flow?** operational-flow is what the business does with a case — rules, owners,
  SLAs. ux-flow is what one person sees and does on screen. A booking screen is ux-flow; the follow-up rule and
  the coordinator's task it feeds are operational-flow. Draw both when both matter, as two designs.
- **In and out.** At least one ${code('ENTRY')} (where they come in) and one ${code('EXIT')}; only an ENTRY comes
  after nothing, so every screen is reached from one.
- **Screens.** Each ${code('SCREEN')} names its ${code('persona')} (declared once on the design in
  ${code('personas: [{ id, label }]')}), its ${code('route')} (no two screens share one), its ${code('wireframe')} and the
  ${code('actions')} it offers.
- **States.** A screen that shows data (${code('dataShown')}) has a ${code('shows')} line to a ${code('UI_STATE')} of each
  variant empty, loading and error (screen-states); success and partial are there when it has them.
- **No dead ends.** Every ${code('USER_ACTION')} leads somewhere: a screen, the system, an exit.
- **Link actions to business steps.** A USER_ACTION carries ${code('refs')} to the operational-flow EVENT it raises
  or ACTION it records, and a SCREEN to the service-blueprint FRONTSTAGE it is. Write those designs first.
- **Wireframes.** The assistant can draw each screen as a wireframe-v1 board and attach it to the issue
  (${code('<name>.wireframe.json')} plus its SVG). Name it on the screen as
  ${code('node.wireframe: { attachment: <json attachment id>, svg: <svg attachment id> }')}; the canvas shows the
  SVG as the screen's thumbnail.

### Refusals and their fix
| Refused | Means | Fix |
|---|---|---|
${REFUSALS.map(([c, means, fix]) => `| ${code(c)} | ${means} | ${fix} |`).join('\n')}

### A template of the project's own
A project whose diagrams none of these draw declares its own in the project document,
${code('workflows.templates')} (${code('PUT /api/projects/<id>/config')}), checked by the same meta-schema:
- **Extend a built-in** (most cases): ${code('{ $schema, id: "<new id>", version: 1, title, purpose, extends: { id: "operational-flow", version: 1 }, nodeTypes?, edgeKinds?, bands?, bandTypes?: { <band>: [<types>] }, rules? }')}.
  It only adds; re-declaring a base type, kind or band is ${code('WORKFLOW_TEMPLATE_EXTENSION_OVERRIDES')}.
- **A complete template** has every field a built-in has.
- Its id is its own — a built-in's id is ${code('WORKFLOW_TEMPLATE_ID_TAKEN')}; ${code('id@version')} twice is
  ${code('WORKFLOW_TEMPLATE_DUPLICATE')}; a type, band, kind, link or preset it names but no template declares is
  ${code('WORKFLOW_TEMPLATE_INVALID')}. A changed template is a new version; one a stored design is drawn in
  cannot be removed (${code('WORKFLOW_TEMPLATE_IN_USE')}).
- **Propose before you write it**: writing the project document takes project admin, and a template changes
  how every design drawn in it is checked. Draft the template, show the owner one design drawn in it, and
  write it once they agree. HOP needs nothing custom: ${code('operational-flow')} is its template.`;

export const WORKFLOW_TEMPLATES_GUIDE: ForgeGuide = {
  slug: 'workflow-templates',
  audience: 'agent',
  title: 'Pick a diagram template for a workflow design',
  summary:
    'Every workflow-v2 design names a diagram template — operational-flow, service-blueprint, ux-flow, state-machine, integration-sequence, decision-model, data-flow, system-context, a preset of one, or a project template — which fixes its node types, bands, edge kinds, required fields and cross-links. Which to pick, what each holds a design to, and how each refusal is fixed.',
  version: 2,
  body: BODY,
};
