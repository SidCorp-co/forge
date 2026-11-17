// The capability cards of the REST doors a master and its runs reach for most (ISS-1251): each row
// of the orientation's operating affordances is one situation of one card, and the table is rendered
// from these cards (`registry.ts:OPERATING_AFFORDANCES_TEXT`), so the row and the card are one text.
// A card stands or the module refuses to load, naming the card.

import {
  type CapabilityCard,
  type CapabilityCardBody,
  capabilityCardSchema,
} from '@forge/contracts/capability-cards';
import { servedCard } from '../../lib/card-changed.js';

/** A card judged whole as it is written, refused by name where it does not stand. */
export const card = (id: string, owner: string, body: CapabilityCardBody): CapabilityCard => {
  const parsed = capabilityCardSchema.safeParse(body);
  if (!parsed.success) {
    const said = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`prompt: the capability card for ${id} does not stand: ${said}`);
  }
  return servedCard(id, owner, parsed.data);
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
    example: {
      dependsOnId: '5b0c9a3e-7f21-4d8e-9a6b-2c1d4e5f6a7b',
      kind: 'blocks',
      reason: 'The reorder screen reads the order cache this issue adds.',
    },
    redFlag:
      'Writing the order in prose (“after ISS-640”) instead of a blocks edge: prose gates nothing.',
    family: 'issue-order',
    audience: ['master', 'run'],
    scenarios: ['an order between issues written as a blocks edge'],
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
    example: {
      projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
      source: 'note',
      sourceRef: 'order-cache-invalidation',
      textContent:
        'The order cache is cleared by the orders write path only; a direct SQL fix leaves it stale.',
      type: 'fact',
      scope: 'packages/core/src/orders',
      recheckWhen: 'when the orders write path changes',
    },
    // forge, 2026-10-17..11-16: 41 of 86 writes refused, among them decisions in force
    // (MEMORY_DECISION_NOT_MEMORY) and texts past the embedding window (MEMORY_TEXT_TOO_LONG)
    redFlag:
      'Writing a decision in force as memory, or a second entry beside the one already held.',
    family: 'memory',
    audience: ['master', 'run'],
    scenarios: ['a memory written beside the entry already held: 41 of 86 refused'],
  }),
  card('PUT /api/projects/:id/knowledge/:slug', 'knowledge', {
    purpose: "Writes one entry of the project's own prose: a rule, a guide, build commands.",
    situations: [
      {
        when: 'A decision in force',
        do: 'a rule (`projects/<id>/knowledge/<slug> -X PUT`, kind rule, `module` its module slug) or a requirement',
        watch: 'memory holds no decision in force and refuses one `MEMORY_DECISION_NOT_MEMORY`',
      },
      {
        when: 'A person names a thing (a term)',
        do: '`projects/<id>/knowledge/<slug> -X PUT`, kind glossary, with `module`, `term` (`aliases` vi, code, industry; `namedBy` quoting who named it) and `anchor` (`file.ts:symbol`)',
        watch: '`term` on another kind is refused `MODULE_MAP_TERM_NOT_GLOSSARY`',
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
    example: {
      title: 'Reorder',
      kind: 'glossary',
      body: 'Placing a past order again with its lines and address.',
      module: 'orders',
      injection: 'on_demand',
    },
    redFlag: 'Marking an entry injection always for detail a prompt needs only on demand.',
    family: 'knowledge',
    audience: ['master', 'run'],
    scenarios: ['a project’s own prose kept under one slug per entry'],
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
    example: {
      title: 'The reorder button reads the cache before an order is written',
      description: 'A reorder right after checkout shows the order before the last one.',
      priority: 'medium',
      category: 'bug',
      status: 'draft',
    },
    // forge, 2026-10-17..11-16: 25 of 318 creates refused; the orientation's watch is that `open`
    // triages and dispatches it, and a feature never starts as an issue an agent filed
    redFlag: 'Filing a feature or a user’s finding as an issue, where it starts as feedback.',
    family: 'issue-order',
    audience: ['master', 'run'],
    scenarios: ['a user’s finding filed as an issue instead of feedback'],
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
    example: {
      baseRevision: 2,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/policy-v1.json',
        version: 1,
        qa: 'self',
        intake: { mode: 'auto' },
      },
    },
    redFlag:
      'Sending only the keys that change: the policy is written whole against the revision read.',
    family: 'setup',
    audience: ['master'],
    scenarios: ['a policy written whole against the revision read'],
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
    example: { baseRevision: 7, document: { description: 'Storefront for the shop.' } },
    family: 'setup',
    audience: ['master', 'person'],
    scenarios: ['a patch sent as { base, patch } to the project document: ISS-767, FB-596'],
  }),
  card('POST /api/memory/search', 'memory', {
    purpose: 'Reads what earlier work learned before you design or fix.',
    situations: [{ when: 'Context before you design or fix', do: '`memory/search -X POST`' }],
    practice: [
      'Treat a hit as point-in-time: an unverified one is a lead to check against the code, never a fact.',
      'The hits are the find door’s memory filter in its order; issues are `find` with type issue.',
    ],
    example: {
      projectId: 'd1bb4907-74d9-4228-85ff-76121523af7d',
      query: 'order cache invalidation',
      topK: 5,
    },
    redFlag: 'Acting on an unverified hit as a fact without checking it against the code.',
    family: 'memory',
    audience: ['master', 'run', 'bot'],
    scenarios: ['an unverified memory hit acted on as a fact'],
  }),
  card('POST /api/issues/:id/merge', 'issues', {
    purpose: 'Records where a change landed, the evidence a close and a release read.',
    situations: [
      {
        when: 'A fix made by hand, outside the pipeline',
        do: 'mark it merged (`issues/<id>/merge -X POST`, naming where it landed), then move it to `awaiting_release` and close it while you hold it, each criterion it did not meet named in `unmet` with where it goes; the release record says when it is live (with no production environment, `projects/<projectId>/release-records`)',
        watch: 'an unmet criterion with nowhere to go is refused `CLOSE_CRITERION_UNPLACED`',
      },
      {
        when: 'your change landed on the branch it was cut for',
        do: 'stamp `{"target":"base","commit":"<whole sha>"}`; the stamp records the merge and moves no status, so move the issue to `awaiting_release` yourself',
        for: ['run'],
      },
      {
        when: 'the work landed outside git (a CMS, a docs store, a storefront)',
        do: 'stamp `landing`, where it landed, and no `target`; an entry of `artifacts` another open issue\'s release will ship carries `"carriedBy":"<that issue\'s key>"`',
        watch:
          'refused `ARTIFACT_CARRIER_UNKNOWN`, `ARTIFACT_CARRIER_SELF`, `ARTIFACT_CARRIER_SHIPPED` or `ARTIFACT_CARRIER_DESIGN` where it cannot be',
        for: ['run'],
      },
    ],
    practice: [
      'Verify the commit is on the target branch on the remote before you name it: after a squash merge that is the squash commit; work outside git names `landing` and no commit.',
      'Name what you have (commit and target, landing, artifacts, a liveReading {url,status}); it is recorded as given with who said it, and a named commit is read against the repository as a reading, never a refusal.',
    ],
    example: { target: 'base', commit: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee' },
    // issues/merge-correction.ts: MR 5162's merge stamped a closed issue with a commit over its real
    // landing; forge, 2026-10-17..11-16: 75 of 677 stamps refused
    redFlag:
      'Stamping a commit that is not this issue’s own landing, such as the branch head before a squash.',
    family: 'issue-landing',
    audience: ['master', 'run'],
    scenarios: ['a merge stamped at the branch head before the squash'],
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
      {
        when: "your issue waits on another issue's landing",
        do: 'leave it where it is and add a `blocks` edge (`issues/<dependent>/dependencies -X POST`): a park is only for an act a person owes',
        watch: "a park naming another issue's mark is refused `QUESTION_MERGE_IS_ORDERING`",
        for: ['run'],
      },
      {
        when: 'your issue waits on its own landing being recorded',
        do: 'park it through `issues/<id>/transition` with `"awaitsMerge":{"issueId":"<id>"}`, naming this issue instead of describing it in `needs`; the stamp of its merge mark answers it',
        watch: 'a mark already standing is refused `QUESTION_MERGE_ALREADY_MARKED`: carry on',
        for: ['run'],
      },
      {
        when: 'a person owes an answer, a decision or a resource you cannot make',
        do: 'park it through `issues/<id>/transition`, sending `{"toStatus":"needs_info"}` with `reason`, `waitingKind` and `needs` on the one call, `needs` written as the ask itself',
        watch:
          'on an issue that delivers a requirement or carries feedback, `needs` with no `about` is refused `QUESTION_ABOUT_REQUIRED`: name the item it is asked on, in the shapes `POST /api/questions` takes',
        for: ['run'],
      },
      {
        when: 'your issue waits on the approval of a design revision',
        do: 'park it through `issues/<id>/transition` with `{"toStatus":"needs_info","waitingKind":"needs_decision","reason":"<why>","awaitsDesign":{"workflowId":"<id>","revision":2}}`, or a list of 1 to 20 revisions; `needs` may be left out, since the decision settles it. Approve or return answers the park\'s question, and the issue moves back once every revision is decided',
        watch:
          'a revision not awaiting its approver is refused `QUESTION_DESIGN_UNKNOWN` or `QUESTION_DESIGN_NOT_AWAITING`; a `needs_decision` park without it takes the one revision proposed under the issue, `QUESTION_DESIGN_AMBIGUOUS` where several are',
        for: ['run'],
      },
    ],
    practice: [
      'Say why in a comment first; closed means its criteria were met in scope.',
      'The status moves only here: `issues/<id> -X PATCH` writes fields, never the status.',
      'A park takes `reason` and `waitingKind` on the one call (WAITING_KIND_REQUIRED, TRANSITION_REASON_REQUIRED) and waits on one fact: `needs`, `awaitsMerge` or `awaitsDesign`; a move outside the lifecycle is ILLEGAL_TRANSITION, naming the legal ones.',
    ],
    example: {
      toStatus: 'needs_info',
      reason: 'The owner decides whether a reorder keeps the old prices.',
      waitingKind: 'needs_decision',
      needs: 'Does a reorder keep the prices of the original order, or take today’s?',
    },
    // forge, 2026-10-17..11-16: 264 of 1,828 moves refused; a park naming another issue's landing
    // is QUESTION_MERGE_IS_ORDERING, a blocks edge's job
    redFlag:
      'Parking an issue that waits on another issue’s landing, where a blocks edge orders it.',
    family: 'issue-landing',
    audience: ['master', 'run'],
    scenarios: ['an issue parked on another issue’s landing: QUESTION_MERGE_IS_ORDERING'],
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
    example: { workflowId: '3d2b8c4e-1a5f-4e7d-9b6c-0f1e2d3c4b5a', revision: 3, issue: 'ISS-640' },
    redFlag:
      'Filing or dispatching the build of a design before its revision is proposed and approved.',
    family: 'design',
    audience: ['master', 'run', 'person'],
    scenarios: ['a finished draft design proposed for approval before its build'],
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
    example: {
      kind: 'bug',
      title: 'Reorder shows the order before the last one',
      body: 'Right after checkout, Reorder on the order page lists the previous order’s lines.',
      target: { kind: 'requirement', ref: 'REQ-12' },
    },
    family: 'project-feedback',
    audience: ['master', 'run', 'bot', 'person'],
    scenarios: ['two target fields filled on one feedback: FEEDBACK_TARGET_NOT_ONE (FB-598)'],
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
    example: {
      items: [
        {
          kind: 'simplify',
          where: 'packages/core/src/orders/cache.ts:readOrder',
          detail: 'Two cache reads repeat one query; one read would do.',
          impact: { rating: 'low', type: 'logic', reason: 'One extra query per order page.' },
        },
      ],
    },
    family: 'debt',
    audience: ['master', 'run'],
    scenarios: ['a red rated high left as debt while the issue landed'],
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
    example: {
      body: 'Extra fixes: the order cache was not cleared on reorder; fixed in orders/cache.ts.',
    },
    // forge, 2026-10-17..11-16: 98 of 7,257 comments refused; a defect only mentioned in a comment is
    // not discharged (CLAUDE.md, "A defect you see has a place")
    redFlag:
      'Mentioning a standalone defect only in a comment, where it belongs on the debt ledger.',
    family: 'issue-work',
    audience: ['master', 'run'],
    scenarios: ['a standalone defect left in an issue comment, recorded nowhere'],
  }),
];

/** A situation in the orientation a master meets; a run reads its own in its map. */
const forMaster = (s: CapabilityCard['situations'][number]) => !s.for || s.for.includes('master');

/**
 * The orientation table's rows: one per situation a master meets, each with what to watch
 * for in it, and after a card's own rows each situation a lesson folded into it (`proposed`, by card
 * id), marked as proposed until the card's code carries it.
 */
export function affordanceRows(
  cards: readonly CapabilityCard[] = AFFORDANCE_CARDS,
  proposed: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  return cards
    .flatMap((c) => {
      const own = c.situations.filter(forMaster);
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
