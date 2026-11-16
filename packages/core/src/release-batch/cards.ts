// The capability cards of the release doors a master and a release run call over REST (ISS-1251),
// beside their routes (`routes.ts`, `version-routes.ts`), keyed by the door as the published contract
// lists it and built into the door catalog by `mcp/rest-cards.ts`. Naming a release and deciding its
// approval are the forge_releases door's (`releases.name`, `releases.decide`), so their REST twins
// carry no second card. Written from the release runs, sweeps and hand records on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const ISSUE = '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10';

export const RELEASE_REST_CARDS = {
  'POST /api/projects/:projectId/release-records': {
    purpose: 'Records a release the agent made outside a release run, under its explicit version.',
    situations: [
      {
        when: 'you released a batch by the project’s own route and it is live',
        do: 'record it naming the version it shipped as, its issues and how it was released',
      },
      {
        when: 'a release run was aborted back to the gate but the release did land',
        do: 'record it here, so its issues close on your record rather than by hand',
      },
    ],
    practice: [
      'The version is the one the tag and the running app report; no commit is matched for you.',
      'Any verdict standing on its issues is weighed: a non-commit identity is refused.',
    ],
    example: {
      issueIds: [ISSUE],
      version: '1.31.1',
      account: 'Deployed 1.31.1 to production from tag v1.31.1; /api/version reports 1.31.1.',
    },
    // ISS-1062 era: client projects closed issues through this door on runtime-identity verdicts the
    // door did not weigh; it now refuses them
    redFlag:
      'Recording a release from the merge alone, before reading that the running app serves it.',
    audience: ['master'],
  },
  'POST /api/projects/:projectId/release-batches': {
    purpose:
      'Cuts a release of the issues waiting at awaiting_release, under a version or a fresh one.',
    situations: [
      {
        when: 'a batch landed and its issues wait at awaiting_release with nothing cutting them',
        do: 'cut a release of exactly those issues, giving the version where the project names one',
      },
    ],
    practice: [
      'Adding or dropping an issue makes a new release, never a changed one.',
      'A release cut by hand names you as its cutter; the sweep’s cut names no person.',
    ],
    example: { issueIds: [ISSUE], version: '0.27.0', name: 'Reorder in one tap' },
    audience: ['master'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/abort': {
    purpose: 'Ends a release run that cannot finish, saying why and what it left outside Forge.',
    situations: [
      {
        when: 'a release run stopped and cannot go on (a red cut, a deploy that did not come up)',
        do: 'abort it with a reason and `carried`: each tag, commit or notice left with its version',
      },
      {
        when: 'Forge tells you a run holds its issues at their release step after it stopped',
        do: 'abort with promotedRoster return-to-gate, then record the release if it did land',
      },
    ],
    practice: ['carried [] says nothing left; leaving it out leaves the version undecided.'],
    example: {
      reason: 'The deploy did not come up: /api/health 502 for 10 minutes.',
      promotedRoster: 'return-to-gate',
      carried: [{ kind: 'tag', name: 'v0.27.0' }],
    },
    // ISS-670's judge (2026-10-23): an abort sent as {} recorded "aborted by agent" with no reason
    redFlag: 'Aborting with an empty body: the run ends with no reason and its version undecided.',
    audience: ['master'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/carried': {
    purpose:
      'Says after the fact what an aborted release left outside Forge with its version on it.',
    situations: [
      {
        when: 'a cut is refused RELEASE_VERSION_UNDECIDED, naming an aborted run of yours',
        do: 'declare what that run left (tags, commits, artifacts, notices), or [] for nothing',
      },
    ],
    practice: ['It only adds; a run still open says it on its own abort instead.'],
    example: { carried: [{ kind: 'tag', name: 'dev-v0.4.0-dev.438' }] },
    audience: ['master'],
  },
  'POST /api/projects/:projectId/shipped-in-records': {
    purpose: 'Closes an awaiting_release issue on a shipped release that already holds its commit.',
    situations: [
      {
        when: 'an issue was marked merged after the cut that shipped its commit, so no release claimed it',
        do: 'record it shipped in that release, with evidence the release contains its commit',
      },
      {
        when: 'an issue’s shipped-in record named the wrong release',
        do: 'send it again with `corrects` naming the version it names now, and a reason',
      },
    ],
    practice: [
      'A release that does not contain the commit is refused, and so is one the host cannot read.',
    ],
    example: {
      issueId: ISSUE,
      version: '0.37.0',
      evidence: 'Commit 9c6d6ded is an ancestor of tag v0.37.0 (git merge-base --is-ancestor).',
    },
    // ISS-846: a second record on the same issue was refused RELEASE_SHIPPED_IN_NOT_WAITING until
    // `corrects` existed; masters had recorded late marks by hand for days (ISS-813 to ISS-879)
    redFlag:
      'Cutting a new, empty release for an issue whose commit an older release already shipped.',
    audience: ['master'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/approvals': {
    purpose: 'Opens the approval request a production release waits on, with its evidence.',
    situations: [
      {
        when: 'a release run on a project that requires approval waits on you to ask for it',
        do: 'open the request with the commit staged and what you read there; the decision is theirs',
      },
    ],
    practice: [
      'A project that declares no production has no gate to approve: there is nothing to open.',
    ],
    example: {
      evidence: {
        commit: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee',
        environment: 'staging',
        reading: 'Staging serves c82e7d7c3a; every criterion of the roster passes there.',
      },
    },
    audience: ['master'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/method': {
    purpose: 'Says which method a release run works from, before it records anything else.',
    situations: [
      {
        when: 'you start a release run and a deploy or a record is refused RELEASE_NOTHING_RECORDED',
        do: 'record the skill you work from and that you loaded it, then go on',
      },
    ],
    practice: ['Send it first in every release run.'],
    example: { skill: 'forge:release-flow', loaded: true },
    audience: ['master'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/shipped-commit': {
    purpose: 'Names the commit a release run shipped where its merge marks leave it unanswered.',
    situations: [
      {
        when: 'a release run cannot tell which commit it shipped from its issues’ marks',
        do: 'name the commit the running app serves, with evidence',
      },
    ],
    practice: [
      'The commit must hold every landing of the roster; a commit another run holds is refused.',
    ],
    example: {
      commit: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee',
      evidence: '/api/version reports sourceCommit c82e7d7c3a.',
    },
    audience: ['master'],
  },
  'POST /api/projects/:projectId/releases/:version/repair': {
    purpose: 'Repairs a release recorded failed that did ship, keeping the failure on its record.',
    situations: [
      {
        when: 'a release reads failed but it was approved, merged and is served live',
        do: 'repair it to shipped with why and the evidence it is live; it takes project admin',
      },
    ],
    practice: ['Name the failure too as Forge feedback: a repair is evidence, not the fix.'],
    example: {
      outcome: 'shipped',
      reason: 'The run ended failed with no code, but the release is live.',
      evidence: 'MR !5136 merged at b4bbce6f; production serves 0.9.0.',
    },
    // ISS-928 / FB-484: the repair became a routine workaround for runs that ended failed with no code
    redFlag: 'Repairing every failed release by routine instead of reporting why runs end failed.',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
