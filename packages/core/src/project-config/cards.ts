// The capability cards of the project-config doors agents call over REST (ISS-1251): the secret a
// master patches to finish a testing actor's sign-in, a testing profile, and the project's variables,
// which an agent proposes and a person writes. Each sits beside its route (`secret-routes.ts`,
// `routes.ts`, `variables-routes.ts`), keyed by the door as the published contract lists it and built
// into the door catalog by `mcp/rest-cards.ts`. The project document and gate
// writes are forge_config's (`tool.cards.ts`), so their REST twins carry no second card. Written from
// ISS-1140, ISS-1141 and ISS-1145, where judges could not sign in to an app, and from the calls these
// doors took on forge between 2026-10-17 and 2026-11-16.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const PROJECT_CONFIG_REST_CARDS = {
  'PATCH /api/projects/:id/secrets/:scope/:name': {
    purpose:
      'Adds named non-secret keys to a stored secret’s value without the value leaving core.',
    situations: [
      {
        when: 'judge-login is refused because a testing actor’s secret lacks how the app signs in',
        do: 'patch the keys the refusal names (loginRoute and its kin) into that secret, as a project admin',
      },
    ],
    practice: [
      'Only the keys the door names are taken; the password is never retyped or read back.',
    ],
    example: { set: { loginRoute: '/api/auth/login' } },
    // ISS-1140: judge-login's refusal named a fix no door accepted, so masters asked for the password
    // again to retype the whole secret
    redFlag: 'Asking a person to retype a secret’s whole value to add a sign-in route to it.',
    family: 'setup',
    audience: ['master'],
    scenarios: ['a password asked again to add a sign-in route to a secret: ISS-1140'],
  },
  'PUT /api/projects/:id/testing-profiles/:profileId': {
    purpose:
      'Writes a testing profile: the actors and services a judge signs in as, by secret reference.',
    situations: [
      {
        when: 'a judge needs an actor or service it cannot sign in as on an environment',
        do: 'get the profile, add the actor naming its secret:// reference, and write it whole back',
      },
    ],
    practice: [
      'Its document names references, never values; the id in the document is the one in the URL.',
      'Write it whole with the baseRevision you read, as a project admin.',
    ],
    example: {
      baseRevision: 3,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
        version: 1,
        id: 'dev',
        actors: { member: { role: 'project-member', credential: 'secret://dev/qa' } },
        services: {},
      },
    },
    // forge, 2026-10-17..11-16: 4 of 6 writes refused, among them a document whose id was not the
    // URL's (TESTING_PROFILE_ID_MISMATCH)
    redFlag: 'Writing a password or token into the profile instead of a secret:// reference to it.',
    family: 'setup',
    audience: ['master'],
    scenarios: ['a testing profile written under another id: TESTING_PROFILE_ID_MISMATCH'],
  },
  'POST /api/projects/:id/variables/proposals': {
    purpose: 'Proposes a change to a project variable that a holder of env.manage approves.',
    situations: [
      {
        when: 'your work needs a variable set or removed on an environment',
        do: 'propose it on the issue that needs it, with the reason; it takes effect once approved',
      },
    ],
    practice: [
      'An agent never writes a variable itself: this proposal is its one way.',
      'A set left without `protected` keeps the variable’s own; no proposal turns protection off (VARIABLE_PROPOSAL_UNPROTECTS).',
    ],
    example: {
      act: 'set',
      environment: 'staging',
      key: 'ORDER_CACHE_TTL',
      type: 'plain',
      value: '300',
      issue: 'ISS-640',
      reason: 'The reorder fix reads the cache lifetime from the environment.',
    },
    // forge: both proposals in the window were refused, each naming no issue of the project
    // (VARIABLE_PROPOSAL_ISSUE_UNKNOWN)
    redFlag:
      'Proposing a change with no issue that needs it, or a secret value in a plain variable.',
    family: 'setup',
    audience: ['master', 'run'],
    scenarios: ['a variable proposal naming no issue: VARIABLE_PROPOSAL_ISSUE_UNKNOWN'],
  },
  'POST /api/projects/:id/variables': {
    purpose: 'Creates a project variable on an environment, as a holder of env.manage.',
    situations: [
      {
        when: 'a person adds a variable to an environment',
        do: 'create it with its key, type, environment and value',
      },
    ],
    practice: ['An agent proposes instead (…/variables/proposals).'],
    example: {
      environment: 'staging',
      key: 'ORDER_CACHE_TTL',
      type: 'plain',
      protected: false,
      value: '300',
    },
    // forge, 2026-10-17..11-16: 4 of 5 creates refused, 3 forbidden to agent credentials
    redFlag:
      'An agent writing a variable directly: it is refused VARIABLE_AGENT_PROPOSES and proposes instead.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['agent credentials creating variables: VARIABLE_AGENT_PROPOSES'],
  },
  'PUT /api/projects/:id/variables/:variable': {
    purpose: 'Changes a project variable’s value or kind against the version read.',
    situations: [
      {
        when: 'a person changes a variable’s value',
        do: 'send the new value with the baseVersion you read',
      },
    ],
    practice: ['A version moved past is refused VARIABLE_STALE: read it again.'],
    example: { baseVersion: 2, value: '600' },
    // forge: both writes in the window were the steward's, forbidden
    redFlag:
      'An agent writing a variable directly: it is refused VARIABLE_AGENT_PROPOSES and proposes instead.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['the steward writing a variable’s value, forbidden'],
  },
  'DELETE /api/projects/:id/variables/:variable': {
    purpose: 'Removes a project variable.',
    situations: [
      { when: 'a person removes a variable no environment needs', do: 'delete it by its id' },
    ],
    practice: ['An agent proposes the removal with act delete instead.'],
    example: {},
    // forge: 2 of 3 deletes, the steward's, forbidden
    redFlag:
      'An agent writing a variable directly: it is refused VARIABLE_AGENT_PROPOSES and proposes instead.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['the steward deleting a variable, forbidden: a person decides'],
  },
  'POST /api/projects/:id/variables/:variable/reveal': {
    purpose: 'Shows a secret variable’s value to a holder of env.manage, audited.',
    situations: [{ when: 'a person needs to read a secret variable’s value', do: 'reveal it' }],
    practice: ['A run reads the values it targets at GET /api/jobs/<run>/variables/<environment>.'],
    example: {},
    // forge: 2 of 3 reveals, the steward's, forbidden
    redFlag:
      'An agent revealing a secret to read it, where its job’s own variables read answers it.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['the steward revealing a secret to read it, forbidden'],
  },
  'POST /api/projects/:id/environments/:environment/variables/sync': {
    purpose:
      'Writes an environment’s variables into its forge-ops compose target’s env file, server-side.',
    situations: [
      {
        when: 'a variable set on the Variables page must reach an app a forge-ops compose target runs',
        do: 'sync that environment; the answer names each key written by fingerprint, never a value',
      },
    ],
    practice: [
      'A protected variable reaches only a production-tier target; each key withheld says why.',
      'A deployment with no forgeOps declared is refused VARIABLE_TARGET_UNBOUND naming what to bind.',
    ],
    example: {},
    // FB-758: epod's production read only its server env file, so a master copied a secret value by
    // hand with forge-ops env, through its own tool call
    redFlag:
      'Copying a variable’s value into a target with forge-ops env set from an agent’s own call.',
    family: 'setup',
    audience: ['master', 'run'],
    scenarios: ['a production value copied by hand into a forge-ops env file: FB-758'],
  },
  'POST /api/projects/:id/environments/:environment/forge-ops/deploy': {
    purpose:
      'Deploys an environment’s forge-ops compose target after writing its variables into the env file.',
    situations: [
      {
        when: 'a release deploys to a forge-ops compose target',
        do: 'deploy through this door with forge-ops’ deploy arguments, so the app starts on the variables Forge holds',
      },
    ],
    practice: [
      'The target is the environment’s declaration; its env file is written before the deploy runs.',
      'A write that fails never deploys: VARIABLE_TARGET_WRITE_FAILED names the key and what was written.',
    ],
    example: { args: { service: 'go-backend', version: 'v1.50.0' } },
    // FB-758: a deploy outside Forge started the app on an env file nobody had written the new value into
    redFlag:
      'Deploying with forge-ops directly after a variable changed, then copying its value by hand.',
    family: 'setup',
    audience: ['master', 'run'],
    scenarios: ['a forge-ops deploy that ran before the variable reached its env file: FB-758'],
  },
  'POST /api/projects/:id/variables/proposals/:proposal/decision': {
    purpose: 'Approves or rejects an agent’s proposed variable change, as a holder of env.manage.',
    situations: [
      {
        when: 'a variable change an agent proposed waits on you',
        do: 'approve or reject it with why',
      },
    ],
    practice: ['A proposal already decided is refused VARIABLE_PROPOSAL_DECIDED.'],
    example: { decision: 'approve', reason: 'Staging only; the value is not secret.' },
    // forge: both decisions in the window were the steward's, forbidden: a person decides
    redFlag: 'An agent approving its own or another agent’s proposal: the decision is a person’s.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['the steward deciding variable proposals, forbidden: a person decides'],
  },
  'DELETE /api/projects/:id/bindings/:bindingId': {
    purpose: 'Removes a project binding to an integration, against the revision read.',
    situations: [
      {
        when: 'a person ends a project’s use of an integration connection',
        do: 'remove its binding with the baseRevision you read',
      },
    ],
    practice: [
      'It takes project admin; a binding’s target changes through bindings.write instead.',
    ],
    example: { baseRevision: 4 },
    // forge: both removals in the window were an agent credential's, forbidden
    redFlag: 'Removing a binding to rewrite it, where bindings.write changes its target in place.',
    family: 'setup',
    audience: ['person'],
    scenarios: ['an agent credential removing a binding, forbidden'],
  },
} satisfies Record<string, CapabilityCardBody>;
