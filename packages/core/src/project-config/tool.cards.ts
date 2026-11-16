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
    redFlag:
      'Guessing a host from another environment, or reading a secret:// reference as the credential.',
    family: 'setup',
    audience: ['person'],
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
    redFlag:
      'Saying why a gate is set from your reading of the profile, where its changes record who set it and why.',
    family: 'setup',
    audience: ['person'],
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
    redFlag:
      'Writing a profile the person did not decide, or overrides for gates their profile already sets as they want.',
    family: 'setup',
    audience: ['person'],
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
    redFlag: 'Telling a person a profile turns a kernel rule off: no profile relaxes them.',
    family: 'setup',
    audience: ['person'],
  },
  // write's one card is its REST twin's, the orientation's (`mcp/twins.ts`)
} satisfies Record<Exclude<ConfigAction, 'write'>, CapabilityCardBody>;

/**
 * When an agent reaches for a project's integration bindings: the forge masters' reads and writes
 * over this door (forge, 2026-10-17..11-16: 3 reads, 6 writes, every write refused), and the
 * envelope the door shares with config.write.
 */
export const BINDINGS_CARDS = {
  get: {
    purpose:
      'Reads a project’s integration bindings as documents: role, connection, target and instructions, and each revision.',
    situations: [
      {
        when: 'you need where a binding points (a host’s project, a deploy target, a monitoring target) or are about to change it',
        do: 'get the binding: its revision is the baseRevision write sends, its document what you change',
      },
    ],
    practice: [
      'A binding with no document form is listed under unrepresentable, and its one read is refused BINDING_NOT_REPRESENTABLE.',
    ],
    example: { projectId: '<project uuid>', binding: '<binding uuid>' },
    redFlag:
      'Looking for a credential here: a connection’s credential stays in core, and a binding names only its connection.',
    family: 'setup',
    audience: ['master'],
  },
  write: {
    purpose: 'Rewrites one binding document whole: its target, instructions or connection.',
    situations: [
      {
        when: 'a binding’s target or instructions are wrong, and the project admin decided the right ones',
        do: 'get it, change the document, and write it whole with the revision get answered',
        watch:
          '{ base, patch } is refused CONFIG_WRITE_SHAPE, and a revision the binding moved past is refused by name',
      },
    ],
    practice: ['It takes project.admin; removing a binding is a person’s act on its own door.'],
    example: {
      projectId: '<project uuid>',
      binding: '<binding uuid>',
      baseRevision: 2,
      document: '<the whole binding document get answered, with your change>',
    },
    redFlag:
      'Writing a binding from memory: all 6 writes on forge (2026-10-17..11-16) were refused. Get it, change it, write it whole.',
    family: 'setup',
    audience: ['master'],
  },
} satisfies Record<'get' | 'write', CapabilityCardBody>;
