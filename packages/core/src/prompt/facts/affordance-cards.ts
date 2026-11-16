// The capability cards of the REST doors a master and its runs reach for most (ISS-1251): each row
// of the orientation's operating affordances is one situation of one card, and the table is rendered
// from these cards (`registry.ts:OPERATING_AFFORDANCES_TEXT`), so the row and the card are one text.
// A card stands or the module refuses to load, naming the card.

import {
  type CapabilityCard,
  type CapabilityCardBody,
  capabilityCardSchema,
} from '@forge/contracts/capability-cards';

/** A card judged whole as it is written, refused by name where it does not stand. */
export const card = (id: string, owner: string, body: CapabilityCardBody): CapabilityCard => {
  const parsed = capabilityCardSchema.safeParse(body);
  if (!parsed.success) {
    const said = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`prompt: the capability card for ${id} does not stand: ${said}`);
  }
  return { id, owner, ...parsed.data };
};

/** The cards, in the order the orientation's table lists their situations. */
export const AFFORDANCE_CARDS: readonly CapabilityCard[] = [
  card('POST /api/issues/:id/dependencies', 'issues', {
    purpose: 'Orders one issue after another, so dispatch waits on the blocker.',
    situations: [
      {
        when: 'Ordering between issues',
        do: 'Blocker known at create time → `projects/<id>/issues -X POST` with `relations:[{ kind:\'blocks\', dependsOnId }]`, committed before the issue dispatches. Both exist → `issues/<dependent>/dependencies -X POST -d \'{"dependsOnId":"<blocker>","kind":"blocks"}\'` (retract with `validUntil` in the past).',
        watch:
          'Only a `blocks` edge gates dispatch, never prose. An `open` issue whose edge is sent in a second call can dispatch in the gap',
      },
    ],
    practice: [
      'Send the edge with the create when the blocker is known; a second call leaves a gap an open issue can dispatch through.',
    ],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/memory', 'memory', {
    purpose: 'Keeps a note or learning another agent on another issue would reuse.',
    situations: [
      {
        when: 'A note or learning',
        do: '`memory -X POST` (durable business logic → repo `docs/`)',
      },
    ],
    practice: [
      'Search first and update the entry already held, rather than writing a second one beside it.',
    ],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('PUT /api/projects/:id/knowledge/:slug', 'knowledge', {
    purpose: "Writes one entry of the project's own prose: a rule, a guide, build commands.",
    situations: [
      {
        when: 'A decision in force',
        do: 'a rule (`projects/<id>/knowledge/<slug> -X PUT`, kind rule) or a requirement',
        watch: 'memory holds no decision in force and refuses one `MEMORY_DECISION_NOT_MEMORY`',
      },
      {
        when: "The project's own prose (build commands, a rule, a guide)",
        do: '`projects/<id>/knowledge/<slug> -X PUT`, one entry per slug, `injection` deciding whether it reaches every prompt',
        watch: '`projectFacts` on the project config is refused by name',
      },
    ],
    practice: [
      'One entry per slug; injection decides whether it reaches every prompt, so keep always-on entries few and short.',
    ],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/projects/:id/issues', 'issues', {
    purpose: 'Files work: born at draft for later, or with its body for work to report.',
    situations: [
      {
        when: 'Work for later',
        do: 'an issue at `draft`',
        watch: '`open` triages and dispatches it',
      },
      {
        when: 'Work to report',
        do: '`title`, `description`, `priority`, `category`; a plan or criteria where you already have them',
      },
    ],
    practice: ['Name the requirement and criteria it delivers where you already have them.'],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('PUT /api/projects/:id/policy', 'project-config', {
    purpose: "Changes the project's policy, written whole against the revision read.",
    situations: [
      {
        when: "The project's policy (`qa`, intake, a status's model or permission profile)",
        do: 'GET `projects/<id>/policy`, then PUT the whole document with the `baseRevision` you read',
        watch: 'A stale revision is refused by name, never merged',
      },
    ],
    practice: ['GET it first and send back the whole document with the baseRevision you read.'],
    audience: ['master'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('PUT /api/projects/:id/config', 'project-config', {
    purpose: 'Changes the project document, written whole against the revision read.',
    situations: [
      {
        when: "The project document (environments, `delivery`, release, bindings' targets)",
        do: 'GET `projects/<id>/config`, then PUT `{ baseRevision, document }`',
        watch: '`{ base, patch }` is refused `CONFIG_WRITE_SHAPE`; a stale revision by name',
        for: ['master'],
      },
      {
        when: 'a project was just created and has no description, repository, branches or environments',
        do: 'write its first document with baseRevision null, shaped by the project-v1 schema and example describe names',
        for: ['person'],
      },
      {
        when: 'a person asks to change the description, the repository, a branch or an environment',
        do: 'get the document, change only that, and write the whole of it back with the revision you read',
        watch:
          'a revision the document has moved past is refused by name: get it again and redo the change',
        for: ['person'],
      },
      {
        when: 'a person asks to change how much they must approve, or a gate',
        do: 'use gates_write; send the document’s gates exactly as get answered them',
        for: ['person'],
      },
    ],
    practice: [
      'GET it first and PUT { baseRevision, document } whole.',
      'Read its shape from describe’s schema, never from a refused write.',
    ],
    // ISS-767: `{ base, patch }` is refused CONFIG_WRITE_SHAPE because it is the natural reading of a
    // revisioned write; FB-596 (gwork, 2026-11-09): gates written here were refused
    // GATES_WRITTEN_THROUGH_THEIR_DOOR, and the client learned the shape from a deliberately invalid write
    redFlag:
      'Sending a patch ({ base, patch } or only the keys that change), or gates changed in the document: refused CONFIG_WRITE_SHAPE and GATES_WRITTEN_THROUGH_THEIR_DOOR.',
    audience: ['master', 'person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/memory/search', 'memory', {
    purpose: 'Reads what earlier work learned before you design or fix.',
    situations: [{ when: 'Context before you design or fix', do: '`memory/search -X POST`' }],
    practice: [
      'Treat a hit as point-in-time: an unverified one is a lead to check against the code, never a fact.',
    ],
    audience: ['master', 'run', 'bot'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/issues/:id/merge', 'issues', {
    purpose: 'Records where a change landed, the evidence a close and a release read.',
    situations: [
      {
        when: 'A fix made by hand, outside the pipeline',
        do: 'mark it merged (`issues/<id>/merge -X POST`, naming where it landed), then move it to `awaiting_release` and close it while you hold it, each criterion it did not meet named in `unmet` with where it goes; the release record says when it is live (with no production environment, `projects/<projectId>/release-records`)',
        watch: 'an unmet criterion with nowhere to go is refused `CLOSE_CRITERION_UNPLACED`',
      },
    ],
    practice: ['Verify the commit is on the target branch on the remote before you name it.'],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/issues/:id/transition', 'issues', {
    purpose: 'Moves an issue along its lifecycle, a park or a drop included.',
    situations: [
      {
        when: 'An issue that turns out not to be work',
        do: 'a comment saying why, then `needs_info` where a person owes the requirement, or `dropped`',
        watch:
          '`closed` says its criteria were met in scope (`CLOSE_REQUIRES_SHIPPED`, `DESIGN_NOT_DELIVERED`)',
      },
    ],
    practice: ['Say why in a comment first; closed means its criteria were met in scope.'],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/projects/:id/workflows/:workflow/design/propose', 'workflows', {
    purpose: "Proposes a revision of a workflow's design for approval.",
    situations: [
      {
        when: "Design work (a workflow's states, steps or rules)",
        do: 'a design revision on that workflow, proposed for approval; an issue holding only design moves to `closed` once its revisions are approved (`design_delivered`)',
        watch: 'a release skips a design-only issue (`RELEASE_ALL_DESIGN_ONLY`)',
        for: ['master', 'run'],
      },
      {
        when: 'a draft design is finished and should be approved before anyone builds it',
        do: 'propose the revision you wrote, naming the issue it is drawn under, and send the approver the design’s page',
        for: ['person'],
      },
      {
        when: 'a revision already waits on its approver and was drawn under the wrong issue',
        do: 'propose it again with issue: no new revision is written, and the earlier issue is told',
        for: ['person'],
      },
    ],
    practice: [
      'An issue holding only design closes once its revisions are approved.',
      'An issue that builds the design is not dispatched until it is approved, so propose before filing the build.',
      'A design resting on another one is approved only once its base is approved at the revision it names.',
    ],
    audience: ['master', 'run', 'person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/projects/:id/feedback', 'feedback', {
    purpose:
      'Files what a user sees or should expect as Feedback, which triage turns into a requirement.',
    situations: [
      {
        when: 'A product finding: it changes what a user sees or should expect (a feature you noticed), or a user or owner reported it',
        do: 'Feedback, `projects/<id>/feedback -X POST`; its triage leads to a requirement, then an issue',
        watch: 'a feature never starts as an issue an agent filed',
        for: ['master', 'run', 'bot'],
      },
      {
        when: 'a person reports something broken or wrong in the product, or relays what a user reported',
        do: 'submit it as a bug in their words, its target the requirement it touches, found with requirements.similar',
        for: ['person'],
      },
      {
        when: 'the report touches no requirement, issue, release, design or endpoint',
        do: 'name the screen it was met on in words as its target, and leave whereSeen out',
        for: ['person'],
      },
      {
        when: 'what they report is about Forge itself, not their project’s product',
        do: 'send it to the feedback door (feedback.submit) instead',
        // ISS-538: a client met two feedback doors and a refusal pointing at the wrong one
        watch:
          'filed here, a Forge defect lands on the project’s own board, where Forge’s team does not triage it',
        for: ['person'],
      },
    ],
    practice: [
      'Say where it was seen and what the person expected, in their words.',
      'The target is one { kind, ref }: a requirement REQ-n is best, else an issue, a release, a workflow or a screen.',
      'Triage is not done here: the project’s master routes the item to its work.',
    ],
    // FB-598 and ISS-559: clients filled several target fields, or named the target as a loose field,
    // and were refused FEEDBACK_TARGET_NOT_ONE; ISS-861: a guide sent clients to project_feedback.create
    redFlag:
      'Naming the target as its own field (screen: …, requirement: …) or naming two, or calling create: the action is submit, with one target { kind, ref }.',
    audience: ['master', 'run', 'bot', 'person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/projects/:projectId/debts', 'cleanup', {
    purpose: 'Records a defect that stands alone as debt for the Audit, with its evidence.',
    situations: [
      {
        when: 'A technical defect of your own that stands alone: against an existing expectation, debt, code to simplify, contract typing (a missing index, an untyped route)',
        do: 'debt for the Audit, `projects/<id>/debts -X POST` with its evidence; an issue of its own (kind as `category`, module as primary label, `Found in:`) only for priority, a handoff or independent tracking (`what-is-an-issue`, *Where what you find goes*)',
        watch: 'cleanup done inside the fix; a defect only mentioned in a comment',
      },
    ],
    practice: [
      'Name where, what and its impact.',
      "A red you rate high stays the issue's to fix: it is recorded, and its RED_RATED_HIGH warning says so.",
    ],
    redFlag: 'A red rated high left as debt while the issue that met it lands.',
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
  card('POST /api/issues/:id/comments', 'comments', {
    purpose: "Writes on the issue what a person should know, in the agent's own words.",
    situations: [
      {
        when: 'A defect your fix needs, to bound its impact or prove itself',
        do: 'fix it there, and say so under `Extra fixes:`; out of reach, a comment on the issue that owns it, a `blocks` edge or `needs_info`',
        watch: 'a defect nobody owns',
      },
    ],
    practice: [
      'Name an extra fix under Extra fixes:, or the issue that owns it where it is out of reach.',
    ],
    audience: ['master', 'run'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  }),
];

/** A situation in the orientation a master or its runs meet. */
const forMasterOrRun = (s: CapabilityCard['situations'][number]) =>
  !s.for || s.for.includes('master') || s.for.includes('run');

/**
 * The orientation table's rows: one per situation a master or its runs meet, each with what to watch
 * for in it, and after a card's own rows each situation a lesson folded into it (`proposed`, by card
 * id), marked as proposed until the card's code carries it.
 */
export function affordanceRows(
  cards: readonly CapabilityCard[] = AFFORDANCE_CARDS,
  proposed: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  return cards
    .flatMap((c) => {
      const own = c.situations.filter(forMasterOrRun);
      const does = own[0]?.do ?? '';
      return [
        ...own.map((s) => {
          const watch = s.watch ?? c.redFlag;
          return `| ${s.when} | ${s.do} |${watch ? ` ${watch} ` : ' '}|`;
        }),
        ...(proposed.get(c.id) ?? []).map((t) => `| (proposed) ${t} | ${does} | |`),
      ];
    })
    .join('\n');
}
