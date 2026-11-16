// The capability cards of the delivery doors a master and a run call over REST through core, which
// holds the source host's and Coolify's credentials (ISS-1251), beside their routes
// (`source-routes.ts`, `issue-merge-routes.ts`, `coolify-routes.ts`, `coolify-env-routes.ts`), keyed
// by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from the deploy-safety and issue-flow guides and the landings, deploys
// and release runs on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const CHANGED = { on: '2026-11-16', by: 'ISS-1251' } as const;
const ISSUE = '6f1c2a0e-5b7d-4c1e-9a3f-2d8e4b6c7a10';

export const INTEGRATION_DOOR_REST_CARDS = {
  'POST /api/projects/:projectId/integrations/source/change-requests': {
    purpose:
      'Opens a pull or merge request on the project’s source host through core, which holds its credential.',
    situations: [
      {
        when: 'the project lands work by change request and your branch is ready to land',
        do: 'open it through core with head, base and a title naming the issue key',
        watch: 'a missing, off or ungranted binding is refused SOURCE_HOST_UNAVAILABLE, naming why',
      },
    ],
    practice: [
      'Name the issue key in the title or body: the host’s merge then links the issue on its own.',
      'Never with a host token of your own: core records only what it opened.',
    ],
    example: {
      head: 'fix/iss583-park-about',
      base: 'dev',
      title: 'ISS-583: a park names what its question is about',
    },
    audience: ['master', 'run'],
    changed: CHANGED,
  },
  'POST /api/issues/:id/merge-pull-request': {
    purpose: 'Merges an issue’s open change request through core, recording the landing it makes.',
    situations: [
      {
        when: 'an issue’s change request is approved and its checks are green',
        do: 'merge it through core naming the request and its head, so the merge is an observed landing',
      },
      {
        when: 'a merge is refused as a conflict while the host shows it mergeable',
        do: 'read the request again and retry once; the host’s first reading can be stale',
      },
    ],
    practice: ['Send headSha: a head that moved since you checked it is not merged.'],
    example: {
      pullRequest: 87,
      headSha: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee',
      method: 'merge',
    },
    // ISS-852 / FB-457: a first merge refused as conflict merged on an identical call 20 s later
    audience: ['master', 'run'],
    changed: CHANGED,
  },
  'POST /api/projects/:projectId/integrations/coolify/deploy': {
    purpose:
      'Deploys a project’s environment through core’s Coolify binding, once per run, binding and commit.',
    situations: [
      {
        when: 'a release run or a fast-lane change is ready to go out to its environment',
        do: 'deploy naming the run or the issue and its targets, then poll the deployment in the foreground',
      },
      {
        when: 'the answer is pendingHumanConfirm on a production that does not deploy on land',
        do: 'tell the person the deploy waits on their confirm and wait; the run stays open',
        watch:
          'that confirm is the kernel’s step for such a project, never a stall to route around',
      },
      {
        when: 'the answer is dispatched false, already-sent',
        do: 'poll the deployment it names; send redeploy true only when you mean to go over it',
      },
    ],
    practice: [
      'Confirm the target environment first; verify the live app serves the commit before calling it done.',
    ],
    example: { pipelineRunId: ISSUE },
    // ISS-1096: release jobs read pendingHumanConfirm as failure, aborted and burned their versions
    redFlag:
      'Aborting the release when the deploy waits on a person’s confirm, or backgrounding the poll and ending the turn.',
    audience: ['master', 'run'],
    changed: CHANGED,
  },
  'PUT /api/projects/:projectId/integrations/coolify/env/:key': {
    purpose:
      'Sets one environment variable of a project’s Coolify app through core, optionally redeploying.',
    situations: [
      {
        when: 'an app needs a variable changed or added and its binding is connected',
        do: 'put the key with its value through core, with redeploy where it must take effect now',
      },
    ],
    practice: ['Values are masked on read: never paste one into a comment or a log.'],
    example: { value: 'https://staging.example.com', redeploy: false },
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/integration-connections/:id/bindings': {
    purpose: 'Binds projects to a connection with what each watches, deploys or reads through it.',
    situations: [
      {
        when: 'a project needs production monitoring and the Prometheus connection is set up',
        do: 'bind it with role monitoring and a target naming its scrapes, probes and rules',
        watch: 'a step the server has not done yet is refused by name, pointing at that setup step',
      },
    ],
    practice: [
      'Rules name a kind Forge writes the PromQL for; raw PromQL is not taken, and `for` is at least 1m.',
      'Read the connection’s readiness first: a binding needing what the server cannot do is refused.',
    ],
    example: {
      bindings: [
        {
          projectId: '0b8e6f4a-2c1d-4e3f-9a5b-7c6d8e9f0a1b',
          role: 'monitoring',
          target: {
            provider: 'prometheus',
            probe: [{ name: 'site', url: 'https://example.com/health', module: 'http_2xx' }],
          },
        },
      ],
    },
    // buy-before-build (forge ISS-1225): projects hand-rolled watch scripts and metrics parsers
    redFlag:
      'Building a watch script or a metrics parser in the project instead of binding it here.',
    audience: ['master'],
    changed: CHANGED,
  },
  'POST /api/integration-connections/:id/monitoring/readiness': {
    purpose: 'Reads now what a Prometheus connection’s server can do, step by setup step.',
    situations: [
      {
        when: 'you followed a connection’s setup list, or a binding was refused for a step not done',
        do: 'read readiness and fix each step that reads false; null means unread, never done',
      },
    ],
    practice: ['Each false names the setup step that turns it true.'],
    example: {},
    audience: ['master'],
    changed: CHANGED,
  },
} satisfies Record<string, CapabilityCardBody>;
