// The capability cards of `forge_config` (ISS-1251), beside the door in `tool.ts`, which would
// otherwise cross its line budget. They are written from how a person's client set a project up over
// MCP (ISS-767, FB-596 on gwork) and from what the product-role and project-settings guides teach.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

type ConfigAction = 'get' | 'write' | 'gates_get' | 'gates_write' | 'gate_profiles';

/** When a person's client reaches for the project document and its gates. */
export const CARDS = {
  get: {
    purpose:
      'Reads the project document whole: description, repository, environments, testing profiles and its revision.',
    situations: [
      {
        when: 'a person asks where the project deploys, which environments it has, or how testers sign in',
        do: 'get it and answer from environments; a testing profile names secret:// references, never a credential',
      },
      {
        when: 'you are about to change anything in the project document',
        do: 'get it first: its revision is the baseRevision your write sends, and its document is what you change',
      },
    ],
    practice: [
      'declared: false means the project has no document yet: the first write sends baseRevision null.',
      'An environment with no URL has none; never guess a host from another one.',
    ],
    example: { projectId: '<project uuid>' },
    audience: ['person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  },
  write: {
    purpose: 'Writes the project document whole, against the revision you read.',
    situations: [
      {
        when: 'a project was just created and has no description, repository, branches or environments',
        do: 'write its first document with baseRevision null, shaped by the project-v1 schema and example describe names',
      },
      {
        when: 'a person asks to change the description, the repository, a branch or an environment',
        do: 'get the document, change only that, and write the whole of it back with the revision you read',
        watch:
          'a revision the document has moved past is refused by name: get it again and redo the change',
      },
      {
        when: 'a person asks to change how much they must approve, or a gate',
        do: 'use gates_write; send the document’s gates exactly as get answered them',
      },
    ],
    practice: [
      'Send the whole document every time; read its shape from describe’s schema, never from a refused write.',
    ],
    example: {
      projectId: '<project uuid>',
      baseRevision: 4,
      document: '<the whole document config.get answered, with your change>',
    },
    // ISS-767: `{ base, patch }` is refused CONFIG_WRITE_SHAPE because it is the natural reading of a
    // revisioned write; FB-596 (gwork, 2026-11-09): gates written here were refused
    // GATES_WRITTEN_THROUGH_THEIR_DOOR, and the client learned the shape from a deliberately invalid write
    redFlag:
      'Sending a patch ({ base, patch } or only the keys that change), or gates changed in the document: refused CONFIG_WRITE_SHAPE and GATES_WRITTEN_THROUGH_THEIR_DOOR.',
    audience: ['person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  },
  gates_get: {
    purpose:
      'Reads the project’s gate profile, each gate’s mode and where it came from, and the last changes with why.',
    situations: [
      {
        when: 'a person asks how much they must approve themselves, or why an act waited on a person',
        do: 'read gates_get and answer from the profile and the mode of the gate in question',
      },
      {
        when: 'a person is about to change the project’s gates',
        do: 'read gates_get first: its revision is the baseRevision gates_write sends',
      },
    ],
    practice: [
      'Quote who changed a gate and why from its changes, not your reading of the profile.',
    ],
    example: { projectId: '<project uuid>' },
    audience: ['person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  },
  gates_write: {
    purpose: 'Sets the project’s gate profile and overrides, kept with who changed them and why.',
    situations: [
      {
        when: 'a person decides the project’s profile (strict, standard or yolo), or how one gate should act',
        do: 'write the profile, overrides only for gates the profile does not set as they want, and their reason',
      },
    ],
    practice: [
      'baseRevision is the project document revision gates_get answered.',
      'Write the reason in the person’s words: it is what the next reader of the change sees.',
    ],
    example: {
      projectId: '<project uuid>',
      baseRevision: 1,
      profile: 'standard',
      reason: 'The team reviews every change before it lands.',
    },
    audience: ['person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  },
  gate_profiles: {
    purpose:
      'Reads the profile table: every gate, what it refuses, its default under each profile and its modes.',
    situations: [
      {
        when: 'a person choosing between strict, standard and yolo asks what each would change for them',
        do: 'read gate_profiles and explain, gate by gate, what each profile refuses and who it asks',
      },
    ],
    practice: ['Name the kernel rules too: no profile relaxes them, so no choice turns them off.'],
    example: { projectId: '<project uuid>' },
    audience: ['person'],
    changed: { on: '2026-11-16', by: 'ISS-1251' },
  },
} satisfies Record<ConfigAction, CapabilityCardBody>;
