/**
 * The instance App's directory row reads what GitHub and Forge hold of it: an installation no
 * project uses, and an App GitHub keeps private (points 3, 4).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAppVisibility } from '../../src/integrations/github/app-standing.js';
import { api } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import { truncateAll } from '../helpers/factories.js';
import {
  bind,
  instanceApp,
  OURS,
  orgOwnedApp,
  record,
  seedGithubWorld,
  stubGitHub,
} from '../helpers/github-instance-world.js';

let session = '';
let otherSession = '';
let project = { id: '', slug: '', orgId: '' };

beforeAll(() => {
  testEnv();
});

beforeEach(async () => {
  await truncateAll();
  forgetAppVisibility();
  ({ session, otherSession, project } = await seedGithubWorld());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rowOf = (token: string, id: string) =>
  api(token, 'GET', `/api/integration-connections/${id}/github-app`);

describe('the instance App’s row', () => {
  it('names an installation recorded for the caller’s org that no project uses, until one does', async () => {
    stubGitHub();
    const connection = await instanceApp();
    await record(connection, OURS, project.orgId);

    const res = await rowOf(session, connection);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.visibility).toBe('public');
    expect(res.body.completePath).toBeNull();
    expect(res.body.installations).toEqual([
      {
        installationId: OURS,
        account: 'SidCorp-co',
        accountType: 'Organization',
        state: 'active',
        used: false,
        settingsUrl: `https://github.com/organizations/SidCorp-co/settings/installations/${OURS}`,
      },
    ]);

    expect((await bind(session, connection, project.id, OURS)).status).toBe(200);
    const after = await rowOf(session, connection);
    expect((after.body.installations as Array<{ used: boolean }>)[0]?.used).toBe(true);

    const theirs = await rowOf(otherSession, connection);
    expect(theirs.body.installations, 'another org’s installations are not theirs').toEqual([]);
  });

  it('PLANT: a private App is named private, with the settings page that makes it public', async () => {
    stubGitHub({ appPage: 404 });
    const connection = await instanceApp();

    const res = await rowOf(session, connection);

    expect(res.body.visibility).toBe('private');
    expect(res.body.owner).toBe('an-operator');
    expect(res.body.makePublicUrl).toBe('https://github.com/settings/apps/forge-test-app/advanced');
  });

  it('PLANT: an answer GitHub did not give leaves visibility unknown, never guessed private', async () => {
    stubGitHub({ appPage: 503 });
    const connection = await instanceApp();

    const res = await rowOf(session, connection);

    expect(res.body.visibility).toBe('unknown');
    expect(res.body.makePublicUrl).toBeNull();
  });

  it('an App not yet the instance’s carries the path an operator completes it with', async () => {
    stubGitHub();
    const connection = await orgOwnedApp(project.orgId);

    const res = await rowOf(session, connection);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.instance).toBe(false);
    expect(res.body.completePath).toBe(
      `/api/integration-connections/${connection}/github-app/complete`,
    );
  });
});
