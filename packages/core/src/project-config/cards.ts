// The capability card of the secret door a master calls over REST to finish a testing actor's sign-in
// (ISS-1251), beside its route (`secret-routes.ts`), keyed by the door as the published contract
// lists it and built into the door catalog by `mcp/rest-cards.ts`. The project document and gate
// writes are forge_config's (`tool.cards.ts`), so their REST twins carry no second card. Written from
// ISS-1140, ISS-1141 and ISS-1145, where judges could not sign in to an app.

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
  },
} satisfies Record<string, CapabilityCardBody>;
