// The capability cards of `forge_ecosystem` (ISS-1251), beside the door in `tool.ts`, which would
// otherwise cross its line budget. They are written from what masters met working builder runs, links
// and contract versions in the epod-catalog and autoflow ecosystems (FB-169, FB-283, FB-320, FB-372,
// FB-501), worked over the REST twins the ecosystem-inbox guide teaches, and from that guide. link and
// builder_run_create carry no card: nothing records or teaches a situation for them.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { Action } from './tool-args.js';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;

/** When an agent reaches for a project's ecosystem records. */
export const CARDS = {
  interface: {
    purpose:
      'Reads the interface this project declares: what it publishes and consumes, its commitments, and its revision.',
    situations: [
      {
        when: 'you are about to publish a contract, change commitments or set what a consumption is built against',
        do: 'read interface first: its revision is the baseRevision interface_write sends',
      },
      {
        when: 'the write that finished a builder run reports report.declaredWithoutCallSite',
        do: 'read interface to see each consumption it declares that no link of yours calls',
      },
    ],
    practice: [
      'commitmentsSetBy says who set the commitments; without commitments.write send them back as they stand.',
    ],
    example: { projectId: '<project uuid>' },
    audience: ['master'],
    changed: CHANGED,
  },
  interface_write: {
    purpose:
      'Writes this project’s interface whole: what it publishes, what it consumes and the commitments it keeps.',
    situations: [
      {
        when: 'this project serves a contract its consumers call and the interface does not name it',
        do: 'add a publishes entry, artifact { upload: true } for an artifact you will upload, then publish its versions',
      },
      {
        when: 'an adopt was refused for an unmeasured or breaking step, and you checked the code against the version',
        do: 'pin it by hand: set that consumption’s builtAgainst here, and each link’s pinnedVersion with link_update',
      },
      {
        when: 'a builder run reports a consumption no link of yours calls',
        do: 'write the link the code uses, or take the consumption out of the interface; never leave it standing',
      },
    ],
    practice: [
      'Send the whole document with the revision interface answered.',
      'builtAgainst names an approved version; a proposed or returned one is refused CONTRACT_VERSION_NOT_APPROVED.',
    ],
    example: {
      projectId: '<project uuid>',
      baseRevision: 3,
      document: '<the whole interface interface answered, with your change>',
    },
    audience: ['master'],
    changed: CHANGED,
  },
  links: {
    purpose:
      'Lists the links this project’s code holds to contracts it consumes: call sites, pinned version, state and revision.',
    situations: [
      {
        when: 'a change notice or a newly approved version moves a contract this project consumes',
        do: 'read links and update the link that calls it with link_update',
      },
      {
        when: 'you work the write-links step of a builder run',
        do: 'read links first, and update the link a use already has rather than create another',
      },
    ],
    practice: ['Each link’s revision here is the baseRevision its link_update sends.'],
    example: { projectId: '<project uuid>' },
    audience: ['master'],
    changed: CHANGED,
  },
  link_create: {
    purpose:
      'Records a link from a module of this project’s code to a contract it consumes, with its call sites.',
    situations: [
      {
        when: 'a builder run matched a use in the code to a contract a member publishes, and no link holds it',
        do: 'create the link from the module that calls it, with every call site, then name its id in the run’s links',
        watch: 'a link that already exists is refused LINK_DUPLICATE: update it with link_update',
      },
    ],
    practice: [
      'A git call site is { path, line, operation }, the path relative to the checkout; a storefront one { artefact: { kind, id }, operation }.',
      'pinnedVersion names an approved version of the contract.',
    ],
    example: {
      projectId: '<project uuid>',
      baseRevision: null,
      document:
        '<a link-v1 document: the consuming module, the contract, pinnedVersion, state, callSites>',
    },
    audience: ['master'],
    changed: CHANGED,
  },
  link_update: {
    purpose:
      'Rewrites one link whole: its call sites, fields used, pinned version, state or notes.',
    situations: [
      {
        when: 'a change notice or an adopted version moved a contract this project consumes',
        do: 'update the link with the call sites, fields and pinnedVersion the code now holds',
      },
      {
        when: 'every call site of a link was deleted from the code',
        do: 'update it once with state building and callSites [], delete it with DELETE /api/projects/:id/links/<link>, and take its id out of the open run’s links',
      },
      {
        when: 'an adopt was refused and you checked the code against the version',
        do: 'set pinnedVersion here by hand, and the consumption’s builtAgainst with interface_write',
      },
    ],
    practice: [
      'Send the whole link with the revision links answered; its consumer and contract never change.',
    ],
    example: {
      projectId: '<project uuid>',
      link: '<link uuid>',
      baseRevision: 2,
      document: '<the whole link-v1 document links answered, with your change>',
    },
    // ISS-790 (FB-372, catalog-fe builder run 966a1da8): a link whose call sites were all deleted was
    // set unverified with a note and left standing
    redFlag:
      'Setting a link whose code is gone to unverified and leaving it: it still reads as a live use. Retire it: building with callSites [], then delete it.',
    audience: ['master'],
    changed: CHANGED,
  },
  builder_runs: {
    purpose: 'Lists this project’s builder runs: the open one to work, and those before it.',
    situations: [
      {
        when: 'your pass was nudged with an open builder run, after a join or a push to the branch this project builds from',
        do: 'read builder_runs, then builder_run the open one, and work its steps in order',
      },
    ],
    practice: [
      'One run per ecosystem is open at a time: work the open one, never open another beside it.',
    ],
    example: { projectId: '<project uuid>' },
    audience: ['master'],
    changed: CHANGED,
  },
  builder_run: {
    purpose:
      'Reads one builder run whole: its trigger and head, steps, findings and links, and its revision.',
    situations: [
      {
        when: 'you are about to start or finish a step of the open run',
        do: 'read it: its revision is the baseRevision builder_run_update sends, and its steps are the ones it opened with',
      },
      {
        when: 'the run’s trigger names a head this project does not build from',
        do: 'do not map it: supersede it with builder_run_supersede and a reason',
      },
    ],
    practice: ['trigger.head says which ref and commit the run maps, and how it was read.'],
    example: { projectId: '<project uuid>', run: '<builder run uuid>' },
    audience: ['master'],
    changed: CHANGED,
  },
  builder_run_update: {
    purpose:
      'Moves the open builder run’s steps and records its findings and links, written whole against its revision.',
    situations: [
      {
        when: 'you start or finish a step of the open run',
        do: 'set it running before you start, and succeeded, failed or skipped with a detail when it ends',
      },
      {
        when: 'your write finishes the run',
        do: 'read report.declaredWithoutCallSite and report.next in the answer: write the missing link or drop the consumption, and work the run next opened',
      },
    ],
    practice: [
      'A finding is matched, outside_ecosystem with its host, or unknown with a note.',
      'superseded is never written here: it is builder_run_supersede’s alone.',
    ],
    example: {
      projectId: '<project uuid>',
      run: '<builder run uuid>',
      baseRevision: 5,
      document: '<the whole builder-run-v1 document builder_run answered, with the step moved>',
    },
    audience: ['master'],
    changed: CHANGED,
  },
  builder_run_supersede: {
    purpose:
      'Closes an open builder run that must not be worked, and opens a fresh one with the steps the current source type derives.',
    situations: [
      {
        when: 'the bus shows the open run stepsStale, or it was opened at a head this project does not build from',
        do: 'supersede it with a reason, then work the fresh run it opens',
      },
      {
        when: 'the open run can never finish truly',
        do: 'supersede it with a reason, rather than mark steps succeeded that did not run',
      },
    ],
    practice: [
      'A project-fenced token reaches it for its own project; a finished run is refused BUILDER_RUN_NOT_OPEN.',
    ],
    example: {
      projectId: '<project uuid>',
      run: '<builder run uuid>',
      reason: 'Opened at a push to main; this project builds from dev.',
    },
    audience: ['master'],
    changed: CHANGED,
  },
  bus: {
    purpose:
      'Reads an ecosystem as you may see it: members, contracts, each link with how the latest version affects it, and runs.',
    situations: [
      {
        when: 'you work a builder run and need what the peers publish, and how each of your links fares against the latest version',
        do: 'read the bus by the ecosystem’s uuid: each link’s impact names the fields, call sites and outside-contract use a version breaks',
      },
      {
        when: 'you need to know whether your open run’s steps still fit the project’s source type',
        do: 'read the bus: stepsStale true means supersede the run, not work it',
      },
    ],
    practice: [
      'bus names an ecosystem, never a project: a projectId beside it is refused.',
      'A project-fenced token reads it for an ecosystem its project is a member of.',
    ],
    example: { ecosystem: '<ecosystem uuid>' },
    audience: ['master'],
    changed: CHANGED,
  },
  context: {
    purpose:
      'Answers the contracts a set of repository paths calls: per link, its guide notes and the diff from its pinned version to the latest.',
    situations: [
      {
        when: 'you are about to change code that may call another project’s contract',
        do: 'load context with the paths you will touch, and your session, before you edit',
      },
      {
        when: 'you need what changed in a provider’s contract since the version your link pins',
        do: 'load context for the calling module’s paths: its diff runs from the pinned version to the latest',
      },
    ],
    practice: [
      'Name session so the load is recorded on it.',
      'From a checkout the same load is POST /api/projects/:id/contract-context { paths, session? }.',
    ],
    example: {
      projectId: '<project uuid>',
      paths: ['apps/web/src/api/orders.ts'],
      session: '<session uuid>',
    },
    audience: ['master', 'run'],
    changed: CHANGED,
  },
  contract_version_publish: {
    purpose:
      'Records a version of a contract this project publishes, from its artifact; core indexes it and measures it against the latest.',
    situations: [
      {
        when: 'a change to a contract this project serves has landed on its base branch',
        do: 'publish the version from the artifact at that commit, sourceRef <path>@<sha>, the version after the latest in the interface’s scheme',
      },
      {
        when: 'a version is refused VERSION_NOT_MEASURED or VERSION_CHANGE_UNKNOWN',
        do: 'name the version yourself: core records the change unknown at that version, never at a MAJOR it guessed',
      },
    ],
    practice: [
      'kind is the publication’s type: graphql takes the SDL text, mcp-tools { tools }, cli { program, commands }.',
      'A recorded version is proposed; it is current only once contract_version_decide approves it.',
    ],
    example: {
      projectId: '<project uuid>',
      contract: 'orders-api',
      version: '1.2.0',
      kind: 'graphql',
      source: '<the SDL text at sourceRef>',
      sourceRef: 'schema.graphql@1a2b3c4',
    },
    // ISS-981 (FB-501, catalog-api): site-sync-events-v1 2.0.0 was recorded from a commit that was not
    // the landed artifact, and the contract holder returned it
    redFlag:
      'Recording a version from a commit that has not landed: sourceRef is a commit on the base branch and the artifact that file byte for byte (CONTRACT_SOURCE_NOT_LANDED, CONTRACT_SOURCE_DIGEST_MISMATCH).',
    audience: ['master'],
    changed: CHANGED,
  },
  contract_version_decide: {
    purpose:
      'Approves or returns a proposed version of a contract this project publishes; only an approved version is current.',
    situations: [
      {
        when: 'this project recorded a version, and outside a strict profile its master decides its own',
        do: 'approve it once it is the artifact that landed, or return it with a reason',
      },
      {
        when: 'a holder of contracts.approve tells you to approve or return a version',
        do: 'decide it as they said, with their reason; a return needs one',
      },
    ],
    practice: [
      'Consumers pin and adopt only an approved version, and the approval settles the issues waiting on it.',
    ],
    example: {
      projectId: '<project uuid>',
      contract: 'orders-api',
      version: '1.2.0',
      decision: 'approve',
    },
    audience: ['master'],
    changed: CHANGED,
  },
} satisfies Partial<Record<Action, CapabilityCardBody>>;
