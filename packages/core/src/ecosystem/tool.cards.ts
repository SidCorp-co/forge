// The capability cards of `forge_ecosystem` (ISS-1251), beside the door in `tool.ts`, which would
// otherwise cross its line budget. They are written from what masters met working builder runs, links
// and contract versions in the epod-catalog and autoflow ecosystems (FB-169, FB-283, FB-320, FB-372,
// FB-501), worked over the REST twins the ecosystem-inbox guide teaches, and from that guide; the red
// flags name the refusals that guide teaches each write around.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { Action } from './tool-args.js';

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
    redFlag:
      'Writing the interface from memory without reading it, so its revision is stale and its commitments are dropped.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['the interface read before a contract is published, its revision sent back'],
  },
  interface_write: {
    purpose:
      'Writes this project’s interface whole: what it publishes, what it consumes and the commitments it keeps.',
    situations: [
      {
        when: 'this project serves a contract its consumers call and the interface does not name it',
        do: 'add a publishes entry, its type the contract kind and artifact { upload: true } for an artifact you will upload (null for an opaque contract), then publish its versions',
      },
      {
        when: 'you set the promise this project keeps to its consumers, or it no longer holds',
        do: 'write commitments: the versioning scheme, deprecationNoticeDays before a breaking change takes effect and responseDays to answer an RFI or a change request, windows the project can keep; the first ones are stored as written',
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
      'Moving commitments already set takes commitments.write (commitmentsSetBy says who set them): without it send them back as they stand, or the write is refused PERMISSION_FORBIDDEN.',
    ],
    example: {
      projectId: '<project uuid>',
      baseRevision: 3,
      document: '<the whole interface interface answered, with your change>',
    },
    // ISS-790 (FB-372, catalog-fe builder run 966a1da8): the use behind a consumption was deleted and
    // the record of it left standing; forge-dev's door use shows no refused interface write to draw on
    redFlag:
      'Leaving a consumption the code no longer calls standing in the interface: a builder run reports it as declaredWithoutCallSite, and the provider’s change notices keep reaching a project that does not use it.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a consumption left standing after its call site was deleted: ISS-790'],
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
    redFlag:
      'Creating a second link for a use a link already holds, instead of updating that one (LINK_DUPLICATE).',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a provider’s new version moving a link this project calls'],
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
    redFlag:
      'Linking what another project uses of yours: a run maps only what this project’s own code calls.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a link created for a use the catalog-fe run found: ISS-790'],
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
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a dead link set unverified and left standing: ISS-790'],
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
    redFlag: 'Opening a run beside the open one (BUILDER_RUN_ALREADY_OPEN): work the open one.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a nudged pass working the open builder run, never one beside it'],
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
    redFlag:
      'Mapping a run whose head is not the branch this project builds from, instead of superseding it.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['the open builder run read before a step is started'],
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
    redFlag:
      'Marking a step succeeded that did not run, or writing superseded here: a run that cannot finish truly is superseded.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a builder run step marked succeeded that did not run'],
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
    redFlag:
      'Superseding a run to escape a step that failed, where the failure is written on the step with its detail.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a stale builder run superseded with a reason, the fresh one worked'],
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
    redFlag:
      'Passing a projectId to bus: it names an ecosystem by its uuid, and a projectId beside it is refused.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['the bus read by the ecosystem’s uuid while working a builder run'],
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
    redFlag:
      'Editing code that calls another project’s contract without loading context first, so the diff since the pinned version goes unread.',
    family: 'ecosystem',
    audience: ['master', 'run'],
    scenarios: ['context loaded for the paths a run will touch before editing a caller'],
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
      {
        when: 'you choose the version to record',
        do: 'take the next in the interface’s scheme: on semver a breaking measurement owes a MAJOR and an additive one a MINOR',
        watch:
          'one too small or outside the scheme is refused VERSION_BUMP_TOO_SMALL or VERSION_NOT_IN_SCHEME',
      },
      {
        when: 'you send the artifact',
        do: 'send a graphql, openapi or json-schema file as it stands at sourceRef, byte for byte, an openapi file in JSON or YAML as it is kept, never converted; describe a cli or mcp-tools contract from the source sourceRef names; leave sourceRef out where you read the artifact from no commit',
        watch:
          'refused CONTRACT_SOURCE_FILE_MISSING, CONTRACT_SOURCE_DIGEST_MISMATCH, or CONTRACT_SOURCE_UNREAD where the source host cannot be read',
      },
      {
        when: 'a version is refused for what it is',
        do: 'read the refusal: CONTRACT_KIND_UNKNOWN or CONTRACT_KIND_MISMATCH names a kind not the publication’s, ARTIFACT_UNREADABLE the line and column the source does not parse at, CONTRACT_NOT_PUBLISHED a contract the interface does not publish',
      },
    ],
    practice: [
      'kind is the publication’s type: graphql takes the SDL text, openapi its JSON or YAML, json-schema its JSON, mcp-tools { tools: [{ name, description, inputSchema }] }, cli { program, commands: [{ name, description?, options? }] }, a command’s name the words after the program.',
      'A recorded version is proposed; it is current only once contract_version_decide approves it, which outside strict the provider’s own master does.',
      'Writing takes contracts.write on this project (member or above); without it the write is refused PERMISSION_FORBIDDEN.',
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
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a contract version recorded from a commit on the base branch'],
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
      // ecosystem/contract/approval.ts:approverRefusal over permissions/master-acts.ts:MASTER_GRANTS
      'contracts.approve is held by the provider project’s admins (an org owner or admin is one on each of its projects), a member its grant names approver, and outside strict its master; anyone else is refused PERMISSION_FORBIDDEN.',
    ],
    example: {
      projectId: '<project uuid>',
      contract: 'orders-api',
      version: '1.2.0',
      decision: 'approve',
    },
    redFlag:
      'Approving a version that is not the artifact that landed, or returning one with no reason.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a master deciding its own contract version where a holder decides it'],
  },
  link: {
    purpose:
      'Reads one link whole: its consumer module, contract, call sites, pinned version, state and revision.',
    situations: [
      {
        when: 'you are about to update or retire one link',
        do: 'read it: its revision is the baseRevision link_update sends',
      },
    ],
    practice: ['links lists them all; link reads the one you change.'],
    example: { projectId: '<project uuid>', link: '<link uuid>' },
    redFlag:
      'Updating a link from the list’s line alone, so its call sites are rewritten from memory.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['one link read for its revision before it is updated'],
  },
  builder_run_create: {
    purpose:
      'Opens a builder run by hand where no run is open, with the steps the project’s source type derives.',
    situations: [
      {
        when: 'no run is open and the code changed in a way no join or push to the built branch opened one for',
        do: 'open one with baseRevision null, then work its steps in order',
        watch: 'a run already open is refused BUILDER_RUN_ALREADY_OPEN: work that one',
      },
    ],
    practice: [
      'A join and a push to the branch this project builds from open a run themselves; this is for the rest.',
    ],
    example: {
      projectId: '<project uuid>',
      baseRevision: null,
      document: '<a builder-run-v1 document: the ecosystem and its manual trigger>',
    },
    redFlag:
      'Opening a run beside the open one, or to replace a stale one, which builder_run_supersede does.',
    family: 'ecosystem',
    audience: ['master'],
    scenarios: ['a builder run opened by hand only where none is open'],
  },
} satisfies Partial<Record<Action, CapabilityCardBody>>;
