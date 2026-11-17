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
    family: 'release',
    audience: ['master'],
    scenarios: ['issues closed on runtime-identity verdicts through a hand record: ISS-1062'],
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
    // forge, 2026-10-17..11-16: 4 of 94 cuts refused, for a version taken or behind the line
    // (RELEASE_CUT_VERSION_TAKEN, RELEASE_CUT_VERSION_BEHIND); the sweep cuts what waits on its own
    redFlag:
      'Naming a version by hand that is taken or behind the project’s line, where the next free one would do.',
    family: 'release',
    audience: ['master'],
    scenarios: ['a release version named by hand that was taken: RELEASE_CUT_VERSION_TAKEN'],
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
    family: 'release',
    audience: ['run'],
    scenarios: ['an abort sent as {}: “aborted by agent” with no reason (ISS-670)'],
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
    // the door refuses a run still open (RELEASE_CARRIED_RUN_OPEN): its own abort says it
    redFlag: 'Declaring what a run left while it is still open, instead of on its own abort.',
    family: 'release',
    audience: ['master'],
    scenarios: ['a cut refused RELEASE_VERSION_UNDECIDED over an aborted run'],
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
    family: 'release',
    audience: ['master'],
    scenarios: ['late merge marks recorded by hand for days: ISS-846'],
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
    // the door refuses evidence whose environment does not fit how the project releases
    // (RELEASE_APPROVAL_EVIDENCE_ENVIRONMENT): a merge-released project's approval names none
    redFlag: 'Opening the request with evidence not read on the environment the approval rests on.',
    family: 'release',
    audience: ['run'],
    scenarios: ['a production release’s approval opened with what was read on its environment'],
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
    // forge, 2026-10-17..11-16: 449 calls, none refused; a deploy or record before it is refused
    // RELEASE_NOTHING_RECORDED, which is how runs that skipped it learned to send it first
    redFlag:
      'Deploying or recording before announcing the method: the run is refused RELEASE_NOTHING_RECORDED.',
    family: 'release',
    audience: ['run'],
    scenarios: ['a deploy before the method: RELEASE_NOTHING_RECORDED'],
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
    // forge: its one call was refused; a commit lacking a roster landing or held by another run is
    // refused (RELEASE_SHIPPED_COMMIT_LACKS_LANDING, RELEASE_SHIPPED_COMMIT_HELD)
    redFlag: 'Naming the commit you merged rather than the one the running app reports serving.',
    family: 'release',
    audience: ['run'],
    scenarios: ['the one shipped-commit call, refused for a commit the roster did not hold'],
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
    family: 'release',
    audience: ['master'],
    scenarios: ['a failed release repaired by routine instead of reported: ISS-928 (FB-484)'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/finish': {
    purpose: 'Records that a release run released its roster, naming the commit production serves.',
    situations: [
      {
        when: 'your release run deployed and you watched production serve the release commit',
        do: 'finish naming that commit, then read release-batches/<runId>/state until finished or failed',
      },
      {
        when: 'a production site was deployed outside Forge in this release',
        do: 'name every production site in `sites` with what it serves, or the release holds as not shipped',
      },
    ],
    practice: [
      'It answers accepted at once; the outcome is finish.state on the run’s state read.',
      'A second finish naming another commit while one runs is refused RELEASE_FINISH_IN_FLIGHT.',
    ],
    example: { commit: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee' },
    // forge, 2026-10-17..11-16: 129 of 548 finishes refused, most while the batch still waited on
    // its approval (RELEASE_AWAITING_APPROVAL) or named no site (RELEASE_SITE_UNDECLARED); the
    // release run's prompt says never to finish because the steps ran without throwing
    redFlag:
      'Finishing because the steps ran without throwing, before the approval is decided or the deploy is seen live.',
    family: 'release',
    audience: ['run'],
    scenarios: ['a release finished while its approval still waited: RELEASE_AWAITING_APPROVAL'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/range': {
    purpose: 'Reports what a release’s commit range ships, from the checkout that cut it.',
    situations: [
      {
        when: 'you pushed the release commit and have not deployed it yet',
        do: 'run `forge-runner release range --project-id <id> --run <runId> --head <sha>` in that checkout',
      },
      {
        when: 'it is refused RELEASE_RANGE_OUTSIDE_ROSTER',
        do: 'do not deploy: cut from a head holding only the roster’s landings and report again, or abort',
      },
    ],
    practice: [
      'Send it through the CLI verb, which reads git; a base this checkout lacks is fetched and sent again.',
      'Forge tags the head you report v<version> once, so the build you deploy reads its version.',
    ],
    example: {
      base: '9c6d6ded0b1e4f2a8a7c5d3e1f0b2a4c6d8e0f1a',
      head: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee',
      changes: [{ path: 'packages/core/drizzle/migrations/0672_x.sql', change: 'added' }],
      files: [{ path: 'packages/core/drizzle/migrations/0672_x.sql', base: null, head: 'ALTER …' }],
    },
    // forge, 2026-10-17..11-16: 14 of 431 reports refused (RELEASE_RANGE_BASE_MOVED and
    // RELEASE_RANGE_OUTSIDE_ROSTER are the ones the release prompt names)
    redFlag:
      'Deploying a head the range refused as outside the roster: it ships issues still waiting at the gate.',
    family: 'release',
    audience: ['run'],
    scenarios: ['a release head outside the roster: RELEASE_RANGE_OUTSIDE_ROSTER'],
  },
  'POST /api/projects/:projectId/release-batches/:runId/range/reads': {
    purpose:
      'Answers which of a release range’s changed files Forge reads, before their text is sent.',
    situations: [
      {
        when: 'you report a release’s range and need to know whose text to send',
        do: 'let `forge-runner release range` ask it; send only the files it names in the report',
      },
    ],
    practice: ['The CLI verb asks it for you; call it by hand only when the verb cannot run.'],
    example: {
      changes: [{ path: 'packages/core/contracts/forge-api.openapi.json', change: 'changed' }],
    },
    // forge, 2026-10-17..11-16: 432 asks, none refused, each from the release range verb
    redFlag:
      'Sending every changed file’s text in the range report instead of only the files this read names.',
    family: 'release',
    audience: ['run'],
    scenarios: ['the range report’s file texts asked by the release range verb'],
  },
} satisfies Record<string, CapabilityCardBody>;
