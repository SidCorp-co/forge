// The scenarios of the ecosystem doors a master works another project's contracts through
// (`ecosystem/`), each from the use forge recorded (GET /api/projects/forge/metrics/doors over the 90
// days to 2026-11-17) or the record its card's comment names: ISS-790's catalog-fe builder run, the
// ePOD/Catalog round behind ISS-246 and ISS-742. A channel action no agent called and no record names
// carries none.

import type { CardScenario } from '../lessons/index.js';

const USE = 'forge door use, 2026-08-19..11-17';
const CATALOG = 'ISS-790 (FB-372, catalog-fe builder run 966a1da8)';

export const ECOSYSTEM_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'a nudged pass reading the inbox once the owed documents were worked',
    card: 'channel.inbox',
    source: `${USE}: 13 inbox reads by masters, none refused`,
    situation: 'A master’s pass has worked what unanswered lists and has room',
    good: 'read inbox for what unanswered leaves out, such as a non-binding change notice',
    teaches: [/read inbox for what unanswered leaves out/i],
  },
  {
    name: 'a provider’s new version moving a link this project calls',
    card: 'ecosystem.links',
    source: `${USE}: 12 link reads by masters, none refused`,
    situation: 'A newly approved version moves a contract this project consumes',
    good: 'read links and update the link that calls it, never create a second one',
    teaches: [/update the link that calls it with link_update/i, /LINK_DUPLICATE/],
  },
  {
    name: 'a dead link left at unverified with a note: ISS-790',
    card: 'DELETE /api/projects/:id/links/:link',
    source: `${CATALOG}; ${USE}: 6 deletes, 4 not found and 2 forbidden`,
    situation: 'The consumer deleted every call site of a contract it linked',
    bad: 'the link was set unverified with a note and left standing',
    good: 'PUT the link building with callSites [] first, then delete it',
    teaches: [/callSites \[\] first, then delete it/i],
  },
  {
    name: 'a stale builder run superseded with a reason, the fresh one worked',
    card: 'ecosystem.builder_run_supersede',
    source: `${USE}: 6 supersedes, 5 refused (not found or error)`,
    situation: 'The bus shows the open builder run stepsStale',
    good: 'supersede it with a reason, then work the fresh run it opens',
    teaches: [/supersede it with a reason, then work the fresh run/i],
  },
  {
    name: 'a contract version recorded from a commit on the base branch',
    card: 'ecosystem.contract_version_publish',
    source: `${USE}: 4 publishes, 2 forbidden`,
    situation: 'A change to a contract this project serves has landed on its base branch',
    good: 'publish the version from the artifact at that commit, the next in the interface’s scheme',
    teaches: [
      /publish the version from the artifact at that commit/i,
      /CONTRACT_SOURCE_NOT_LANDED/,
    ],
  },
  {
    name: 'a channel document named by a person, read whole before answering',
    card: 'channel.read',
    source: `${USE}: 2 document reads by masters`,
    situation: 'A person names a change notice another project sent',
    good: 'read it and answer from its body: what it asks of this project, and by when',
    teaches: [/answer from its body/i, /read it whole before you decide/i],
  },
  {
    name: 'one link read for its revision before it is updated',
    card: 'ecosystem.link',
    source: `${USE}: 2 link reads by masters`,
    situation: 'A master is about to update a link’s call sites',
    good: 'read it: its revision is the baseRevision link_update sends',
    teaches: [/its revision is the baseRevision link_update sends/i],
  },
  {
    name: 'a link created for a use the catalog-fe run found: ISS-790',
    card: 'ecosystem.link_create',
    source: `${CATALOG}; ${USE}: 2 creates, both refused`,
    situation: 'A builder run matched a call in the code to a contract a member publishes',
    good: 'create the link from the module that calls it, with every call site, and name its id',
    teaches: [/create the link from the module that calls it, with every call site/i],
  },
  {
    name: 'the open builder run read before a step is started',
    card: 'ecosystem.builder_run',
    source: `${CATALOG}; ${USE}: 1 run read by a master`,
    situation: 'A master is about to start a step of the open builder run',
    good: 'read it: its revision is what builder_run_update sends',
    teaches: [/its revision is the baseRevision builder_run_update sends/i],
  },
  {
    name: 'a master deciding its own contract version where a holder decides it',
    card: 'ecosystem.contract_version_decide',
    source: `${USE}: 1 decide by a master, forbidden`,
    situation: 'A version this project recorded waits on its decision',
    bad: 'the master decided it where its grants did not reach',
    good: 'approve it once it is the artifact that landed, or return it with a reason',
    teaches: [/approve it once it is the artifact that landed/i],
  },
  {
    name: 'a consumption left standing after its call site was deleted: ISS-790',
    card: 'ecosystem.interface_write',
    source: `${CATALOG}; ${USE}: 1 interface write`,
    situation: 'A builder run reports a consumption no link of this project calls',
    bad: 'the use behind it was deleted and its record left standing',
    good: 'write the link the code uses, or take the consumption out of the interface',
    teaches: [/take the consumption out of the interface/i, /declaredWithoutCallSite/],
  },
  {
    name: 'a cross-project breakdown filed with no contract wait: ISS-246',
    card: 'POST /api/issues/:id/contract-waits',
    source:
      'ISS-246: the ePOD/Catalog round; a breakdown carried no contract wait, a person wrote it',
    situation: 'An issue needs a version of a contract another project will publish',
    bad: 'no wait was written, and a person had to park and wake the issue by hand',
    good: 'write the wait on the contract and its minimum version, never on the provider’s issue',
    teaches: [
      /write the wait on the contract and its minimum version/i,
      /never on the provider’s issue/i,
    ],
  },
  {
    name: 'an adopt-only issue that could not land: ISS-742',
    card: 'POST /api/projects/:id/interface/adopt',
    source: 'ISS-742: an adopt across an unmeasured version had no way but the hand pin',
    situation: 'A provider approved a non-breaking version of a contract this project consumes',
    good: 'adopt it: one transaction writes the interface and moves every link’s pin',
    teaches: [/adopt it: one transaction/i, /adopt never re-pins a baseline/i],
  },
  {
    name: 'another project’s defect carried by a pane message nothing recorded: FB-636',
    card: 'POST /api/projects/:id/channel/handoffs',
    source:
      'FB-636 (sidcorp-mail ISS-18, 2026-11-14): POST projects/<sid-desk>/feedback refused PAT_PROJECT_OUTSIDE_FENCE',
    situation:
      'A master triaging its FB-13 found the defect was in sid-desk’s code, and filing it on sid-desk was refused',
    bad: 'a cross-session message to the sid-desk master pane asking it to file and triage the feedback; nothing in Forge records the handoff except a comment on ISS-18',
    good: 'hand the item to sid-desk’s intake through the channel, so sid-desk holds it as feedback and FB-13 keeps its key',
    teaches: [/hand it to that project’s intake/i, /keeps the key/i],
  },
];
