// The capability cards of the delivery doors a master and a run call over REST through core, which
// holds the source host's and Coolify's credentials (ISS-1251), beside their routes
// (`source-routes.ts`, `issue-merge-routes.ts`, `coolify-routes.ts`, `coolify-env-routes.ts`), keyed
// by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. Written from the deploy-safety and issue-flow guides and the landings, deploys
// and release runs on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import { MONITORING_PROVIDER } from '../monitoring/index.js';

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
    // forge: the steward's one call in the window was refused (no source host bound)
    redFlag:
      'Opening the request with a host token of your own, so core records nothing it opened.',
    family: 'issue-landing',
    audience: ['master', 'run'],
    scenarios: ['a change request opened with no source host bound: SOURCE_HOST_UNAVAILABLE'],
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
    redFlag:
      'Treating a first conflict as final and rebasing, where the host’s first reading was stale.',
    family: 'issue-landing',
    audience: ['master', 'run'],
    scenarios: ['a first merge refused as a conflict, merged by the same call 20 s later: ISS-852'],
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
    family: 'issue-landing',
    audience: ['master', 'run'],
    scenarios: ['a release aborted on pendingHumanConfirm: ISS-1096'],
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
    redFlag: 'Pasting the value into a comment, a log or a commit to show what was set.',
    family: 'setup',
    audience: ['master'],
    scenarios: ['an app variable set through core with redeploy'],
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
            provider: MONITORING_PROVIDER,
            probe: [{ name: 'site', url: 'https://example.com/health', module: 'http_2xx' }],
          },
        },
      ],
    },
    // buy-before-build (forge ISS-1225): projects hand-rolled watch scripts and metrics parsers
    redFlag:
      'Building a watch script or a metrics parser in the project instead of binding it here.',
    family: 'setup',
    audience: ['master'],
    scenarios: ['production monitoring hand-rolled as watch scripts: ISS-1225'],
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
    // the monitoring guide: null means it could not be read, and is never taken as done
    redFlag: 'Reading a null step as done and binding a project before the server can do it.',
    family: 'setup',
    audience: ['master'],
  },
  'POST /api/integration-connections': {
    purpose:
      'Creates an integration connection, such as the Prometheus server projects are watched by.',
    situations: [
      {
        when: 'a project needs production monitoring and no Prometheus connection exists',
        do: 'create one with provider prometheus, its URL, its user and the password its web.yml admits',
        watch: 'without both user and password it is refused MONITORING_SERVER_UNAUTHENTICATED',
      },
    ],
    practice: [
      'An organization’s connection takes org.admin there; a personal one is the caller’s own.',
    ],
    example: {
      provider: MONITORING_PROVIDER,
      config: { prometheusUrl: 'https://prom.example.com', prometheusUser: 'forge', ruler: 'file' },
      secrets: { prometheusPassword: '<the password its web.yml admits>' },
    },
    // buy-before-build: monitoring runs on Prometheus connected here, never a stack the project builds
    redFlag:
      'Pointing Forge at an open endpoint, or standing up a watch stack in the project instead.',
    family: 'setup',
    audience: ['master'],
  },
  'POST /api/integration-connections/:id/monitoring/tokens/:kind': {
    purpose:
      'Mints the token a Prometheus server (sd) or its Alertmanager (alerts) calls Forge with.',
    situations: [
      {
        when: 'the connection’s setup list reads a token file you have not filled',
        do: 'mint sd for the server and alerts for the Alertmanager; each is shown once',
      },
    ],
    practice: ['A new one replaces the old: the server’s file is updated in the same step.'],
    example: {},
    // the guide: the setup list names files, never a secret, and each token is shown once
    redFlag:
      'Pasting a minted token into a comment or the setup list instead of the server’s file.',
    family: 'setup',
    audience: ['master'],
  },
  'POST /api/projects/:projectId/integrations/coolify/cancel': {
    purpose: 'Cancels a Coolify deployment through core’s binding.',
    situations: [
      {
        when: 'a deploy you started is building the wrong commit or hangs past its window',
        do: 'cancel it naming the deployment, then deploy the right one or abort the run',
      },
    ],
    practice: ['Read the deployment first: a finished deploy is not undone by a cancel.'],
    example: { deploymentUuid: 'k8w4c0s8o4g0' },
    redFlag: 'Cancelling a deploy that is still progressing because its poll was slow.',
    family: 'issue-landing',
    audience: ['master', 'run'],
  },
  'PATCH /api/projects/:projectId/integrations/:id': {
    purpose:
      'Changes a project integration: on or off, its config, secrets, instructions or agent access.',
    situations: [
      {
        when: 'a person turns an integration on or off, or changes what agents may do through it',
        do: 'send only the fields that change, as a project admin',
      },
    ],
    practice: ['Agent access is a person’s grant: an agent reads it, never widens it.'],
    example: { active: false },
    // forge: the one agent call was forbidden (access, locked: no agreement widens a grant)
    redFlag: 'An agent widening its own access to an integration.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['an agent widening its own access to an integration, forbidden'],
  },
} satisfies Record<string, CapabilityCardBody>;
