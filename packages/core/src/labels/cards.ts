// The capability card of the label door a master calls over REST (ISS-1251), beside its route
// (`routes.ts`), keyed by the door as the published contract lists it and built into the door
// catalog by `mcp/rest-cards.ts`. Written from the module-taxonomy-migration guide and ISS-609, where
// a design could name no module because the project had none and the agent could not create one.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const LABEL_REST_CARDS = {
  'POST /api/projects/:id/labels': {
    purpose:
      'Creates a project label, or a module label that an issue’s design and primary label name.',
    situations: [
      {
        when: 'a design is refused DESIGN_MODULE_UNKNOWN because the project has no module label for it',
        do: 'as a project admin, create the module label (kind module), parents before children',
      },
      {
        when: 'a project moves its modules from prose onto module labels',
        do: 'read its labels first: promote a plain label of that name rather than creating a second one',
      },
    ],
    practice: [
      'Label names are not unique: create-if-absent keyed on a name that exists as a plain label leaves two rows.',
    ],
    example: { name: 'billing', kind: 'module' },
    // ISS-609: a master's PUT design was refused for a module no label named, and its own create was
    // refused PERMISSION_FORBIDDEN (project.admin)
    redFlag:
      'Naming a module in a design before the project has its label, or creating a second label beside a plain one.',
    family: 'design',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;

/**
 * The module map's doors (ISS-1256, `forge_module`): each card teaches the moments the owner named,
 * when a person names a thing, an owner decides, a requirement is agreed or an issue filed, work starts
 * in a module and work finishes. Nothing makes an agent call them; core infers no module.
 */
export const MODULE_CARDS = {
  get: {
    purpose:
      "Reads one module's tree: its terms, rules, capabilities, requirements, decisions, references and work in flight.",
    situations: [
      {
        when: 'work starts in a module: an issue, a requirement or a question you take sits in it',
        do: 'read its tree first with `module.get <slug>`: its terms name things as the project does, its rules bind your work, its capabilities are the doors already built',
        watch:
          'reading the code from zero while the module already names the term, the rule and the file',
      },
      {
        when: 'a term or a rule in the tree is flagged for re-check',
        do: 'open the code it is anchored at, then rewrite it to match (the rewrite clears the flag) or remove it',
      },
    ],
    practice: [
      'Read it before reading code: each term and rule names the `file.ts:symbol` it is anchored at.',
      'A branch at 0 is a gap to fill when your work meets one, never a reason to stop.',
    ],
    example: { action: 'get', projectId: '<project uuid>', module: 'execution' },
    audience: ['bot', 'master', 'run', 'person'],
  },
  place: {
    purpose:
      'Places one record (term, rule, knowledge, requirement, decision, reference, issue, lesson) in its business module.',
    situations: [
      {
        when: 'a requirement is agreed or an issue is filed and you know the module it is in',
        do: 'set its module with `module.place { type, ref, module }`: a field, never a free label',
      },
      {
        when: 'an owner decides',
        do: 'record the decision on its issue or requirement, place it (`type: decision`), then write the rule under the same module and relate it `from` the decision',
      },
      {
        when: "the pillar's Unplaced row lists a record whose home you know",
        do: 'place it; leave one you are unsure of unplaced, since a gap is shown and never guessed',
      },
    ],
    practice: [
      'Name the module by its slug from your map; an unknown one is refused naming the roots.',
      'Place from what you know (a person said it, the requirement names it, you built it there), never from the files a change touched.',
    ],
    example: {
      action: 'place',
      projectId: '<project uuid>',
      type: 'requirement',
      ref: 'REQ-48',
      module: 'execution',
    },
    redFlag: 'Placing a record by the paths a change touched rather than by what it is about.',
    audience: ['master', 'run', 'person'],
  },
  relate: {
    purpose: 'Ties a term or a rule to what it is used in, governs, comes from or is anchored at.',
    situations: [
      {
        when: 'a person names a thing ("this is called run slots")',
        do: 'write the term (knowledge kind glossary with `module`, `term.aliases` and `term.namedBy` quoting them, `anchor` its code), then relate it `used_in` the rules and capabilities that use it',
      },
      {
        when: 'a rule binds a door or a term rests on a requirement or a decision',
        do: 'relate the rule `governs` the capability, or the term or rule `from` the `REQ-<n>[ BC-<m>]` or decision',
      },
      {
        when: 'a term or a rule lives in code',
        do: 'relate it `anchored_at` `file.ts:symbol`: a landing that changes that file flags it for re-check',
      },
      {
        when: 'work finishes',
        do: 'add the terms and rules you met that the tree lacked, with their relations, and fix those flagged for re-check',
      },
    ],
    practice: [
      'Five kinds only: belongs_to, used_in, governs, from, anchored_at; every stored one starts at a term or a rule.',
      'The same relation written twice stands once; remove a wrong one with `module.unrelate`.',
    ],
    example: {
      action: 'relate',
      projectId: '<project uuid>',
      kind: 'anchored_at',
      from: { type: 'term', ref: 'run-slots' },
      to: { type: 'code', ref: 'packages/core/src/devices/run-slots.ts:slotsFor' },
    },
    redFlag:
      'Reaching for a generic "related" kind, or tying everything to everything: a relation says how two are tied.',
    audience: ['master', 'run', 'person'],
  },
  unrelate: {
    purpose: 'Removes one relation of the module map that was written wrong.',
    situations: [
      {
        when: 'a relation in the tree ties the wrong things, or the code it names is gone',
        do: 'remove it by the id the tree shows, then write the right one',
      },
    ],
    practice: [
      'A term or a rule owing a re-check is fixed by rewriting it, not by removing its anchor.',
    ],
    example: { action: 'unrelate', projectId: '<project uuid>', relationId: '<relation uuid>' },
    audience: ['master', 'run', 'person'],
  },
} satisfies Record<string, CapabilityCardBody>;
