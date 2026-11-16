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
