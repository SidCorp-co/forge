/**
 * ISS-1380 — where a Sentry target is stored, and what refuses it anywhere else.
 *
 * A target is what confines an agent to one project's Sentry projects. Held on the shared connection
 * it is read by every project bound to it, so each door that writes config has to put it on the
 * binding or refuse it by name; a door that quietly dropped it would leave the project with no
 * targets and a form that said it had saved them.
 */

import { describe, expect, it } from 'vitest';
import {
  configSchemaForProvider,
  connectionConfigSchemaForProvider,
  connectionCreateSchema,
  createSchema,
  splitProviderConfig,
} from '../provider-schemas.js';
import { registerAllIntegrations } from '../register-all.js';
import { SENTRY_BINDING_CONFIG_KEYS } from './schemas.js';

registerAllIntegrations();

const core = { label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' };
const web = { label: 'web', organizationSlug: 'canawan', projectSlug: 'forge-web' };

const messagesOf = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) =>
  (result.error?.issues ?? []).map((i) => i.message).join(' | ');

describe('where a project-side write puts targets', () => {
  it('declares targets as a binding-tier key, beside the release channel', () => {
    expect(SENTRY_BINDING_CONFIG_KEYS).toContain('targets');
  });

  it('splits a project create carrying host and targets into a host-only connection and a targets binding', () => {
    const parsed = createSchema.safeParse({
      provider: 'sentry',
      role: 'service',
      config: { host: 'logs.canawan.com', targets: [core, web] },
      secrets: { authToken: 'sntryu_a_token_value' },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const tiers = splitProviderConfig('sentry', parsed.data.config);

    expect(tiers.connection).toEqual({ host: 'logs.canawan.com' });
    expect(tiers.binding).toEqual({ targets: [core, web] });
  });

  it('splits a PATCH carrying targets onto the binding without touching the connection tier', () => {
    const parsed = configSchemaForProvider('sentry').safeParse({ targets: [web] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(splitProviderConfig('sentry', parsed.data as Record<string, unknown>)).toEqual({
      connection: {},
      binding: { targets: [web] },
    });
  });
});

describe('what a Sentry connection refuses to hold', () => {
  it.each([
    ['targets', { host: 'logs.canawan.com', targets: [core] }],
    ['organizationSlug', { host: 'logs.canawan.com', organizationSlug: 'canawan' }],
    ['projectSlug', { host: 'logs.canawan.com', projectSlug: 'web' }],
  ])('refuses %s on a connection create, naming the key', (key, config) => {
    const parsed = connectionCreateSchema.safeParse({
      provider: 'sentry',
      config,
      secrets: { authToken: 'sntryu_a_token_value' },
    });

    expect(parsed.success).toBe(false);
    expect(messagesOf(parsed as never)).toContain(`\`${key}\` is not connection config for Sentry`);
  });

  it('says where the targets go', () => {
    const parsed = connectionConfigSchemaForProvider('sentry').safeParse({ targets: [core] });

    expect(parsed.success).toBe(false);
    expect(messagesOf(parsed as never)).toContain("project's integration");
  });

  it('refuses targets on a connection PATCH rather than storing them beside the host', () => {
    expect(
      connectionConfigSchemaForProvider('sentry').safeParse({ host: 'x.example', targets: [web] })
        .success,
    ).toBe(false);
  });

  it('still takes a host-only connection PATCH', () => {
    expect(
      connectionConfigSchemaForProvider('sentry').safeParse({ host: 'x.example' }).success,
    ).toBe(true);
  });

  it('refuses the legacy single-slug pair on a project-side write too, instead of dropping it', () => {
    const parsed = configSchemaForProvider('sentry').safeParse({
      organizationSlug: 'canawan',
      projectSlug: 'web',
    });

    expect(parsed.success).toBe(false);
    expect(messagesOf(parsed as never)).toContain(
      '`targets: [{ label, organizationSlug, projectSlug }]`',
    );
  });
});

describe('the targets a binding may declare', () => {
  it('refuses two targets with one label, because a read naming it would have to guess', () => {
    const parsed = configSchemaForProvider('sentry').safeParse({
      targets: [core, { ...web, label: 'core' }],
    });

    expect(parsed.success).toBe(false);
    expect(messagesOf(parsed as never)).toContain('both labelled "core"');
  });

  it('takes an organization-wide target with no project slug', () => {
    expect(
      configSchemaForProvider('sentry').safeParse({
        targets: [{ label: 'org', organizationSlug: 'canawan' }],
      }).success,
    ).toBe(true);
  });
});
