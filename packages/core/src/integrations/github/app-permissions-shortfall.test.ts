/**
 * ISS-1153 — what an installation is short of, and how Forge says so.
 *
 * The healthcheck side of the comparison: `app-permissions.test.ts` holds the manifest side and the
 * checker that derives what the code needs.
 */

import { describe, expect, it } from 'vitest';
import {
  appPermissionsPageUrl,
  describeShortfall,
  installationShortfall,
  requiredAppPermissions,
} from './app-permissions.js';

describe('what an installation is short of (ISS-1153)', () => {
  const granted = Object.fromEntries(requiredAppPermissions());

  it('finds nothing short in an installation granting everything', () => {
    expect(installationShortfall(granted)).toEqual([]);
  });

  it('names a permission the installation does not hold at all', () => {
    const { administration: _gone, ...without } = granted;
    expect(installationShortfall(without)).toEqual([
      { permission: 'administration', required: 'read', held: null },
    ]);
  });

  it('names a permission the installation holds below the level needed', () => {
    expect(installationShortfall({ ...granted, contents: 'read' })).toEqual([
      { permission: 'contents', required: 'write', held: 'read' },
    ]);
  });

  it('treats a level it does not recognise as a shortfall rather than a pass', () => {
    expect(installationShortfall({ ...granted, checks: 'maybe' })).toEqual([
      { permission: 'checks', required: 'write', held: 'maybe' },
    ]);
  });

  it('points an organisation-owned App at its own settings page', () => {
    expect(
      appPermissionsPageUrl({
        slug: 'forge-dev',
        ownerLogin: 'SidCorp-co',
        ownerType: 'Organization',
      }),
    ).toBe('https://github.com/organizations/SidCorp-co/settings/apps/forge-dev/permissions');
  });

  it('points a personal App at the personal settings page', () => {
    expect(
      appPermissionsPageUrl({ slug: 'forge-dev', ownerLogin: 'someone', ownerType: 'User' }),
    ).toBe('https://github.com/settings/apps/forge-dev/permissions');
  });

  it('says the permission, the page and that the installation must then accept it', () => {
    const said = describeShortfall({
      repository: 'SidCorp-co/forge',
      shortfall: [{ permission: 'administration', required: 'read', held: null }],
      permissionsUrl:
        'https://github.com/organizations/SidCorp-co/settings/apps/forge-dev/permissions',
      installationUrl: 'https://github.com/organizations/SidCorp-co/settings/installations/42',
    });
    expect(said).toContain('`administration: read`');
    expect(said).toContain('/settings/apps/forge-dev/permissions');
    expect(said).toContain('accept the new grant on the installation');
    expect(said).toContain('https://github.com/organizations/SidCorp-co/settings/installations/42');
  });

  it('still names the page in prose when GitHub would not say who the App is', () => {
    const said = describeShortfall({
      repository: 'SidCorp-co/forge',
      shortfall: [{ permission: 'administration', required: 'read', held: null }],
      permissionsUrl: null,
      installationUrl: null,
    });
    expect(said).toContain("the App's own page, not the installation's");
    expect(said).toContain('accept the new grant on the installation');
  });
});
