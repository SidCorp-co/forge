/**
 * ISS-1421 r18, criterion 171 — judge-75 sent a Coolify binding `targets[0].healthURL` (meant
 * `healthUrl`), `colour` and `resourceUUID`: each answered 200 and the value was lost, because every
 * provider's config schema stripped a field it did not name. Each is refused by name now, with the
 * field near it the provider takes, at create, at a PATCH and inside an array entry.
 */

import { PROVIDER_LABELS } from '@forge/contracts/health-words';
import { describe, expect, it } from 'vitest';
import { refusalMessage } from '../lib/refusal-sentence.js';
import { schemaRefusalWords } from '../lib/zod-sentences.js';
import {
  applySecretsPatch,
  configSchemaForProvider,
  connectionConfigSchemaForProvider,
  connectionCreateSchema,
  createSchema,
  noKeyToSaveMessage,
  providerHalfRefused,
  undeclaredProviderMessage,
} from './provider-schemas.js';
import { registerAllIntegrations } from './register-all.js';
import { listIntegrations } from './registry.js';
import type { IntegrationConnectionRow } from './store.js';

registerAllIntegrations();

const target = { label: 'web', resourceUuid: 'abc123' };
const coolify = (config: Record<string, unknown>) => ({
  provider: 'coolify',
  role: 'deploy',
  stages: ['live'],
  config: { baseUrl: 'https://coolify.example.com', targets: [target], ...config },
  secrets: { apiToken: 'a-token-of-length' },
});

/** The message a refused create body is said in, through the shared sentence builder. */
function createRefusal(body: unknown): string {
  const r = createSchema.safeParse(body);
  if (r.success) throw new Error('expected the create body to be refused');
  const issues = r.error.issues.map((i) => ({ path: i.path, message: i.message, code: i.code }));
  return issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
}

/** The message a PATCH's refused config half answers with. */
function patchRefusal(provider: string, config: unknown, connection = false): string {
  const schema = connection
    ? connectionConfigSchemaForProvider(provider)
    : configSchemaForProvider(provider);
  const r = schema.safeParse(config);
  if (r.success) throw new Error('expected the config patch to be refused');
  return providerHalfRefused(r.error, schema, 'config', config).message;
}

describe('a provider config field the provider does not take', () => {
  it('is refused at create, naming the field it may have meant inside an array entry', () => {
    const said = createRefusal(
      coolify({ targets: [{ ...target, healthURL: 'https://x.example.com/health' }] }),
    );
    expect(said).toContain('config.targets.0.healthURL: is not one this call takes.');
    expect(said).toContain('This call takes config.targets.0.healthUrl');
  });

  it('is refused at create beside the well-formed field it repeats in another case', () => {
    const said = createRefusal(
      coolify({ colour: 'red', targets: [{ ...target, resourceUUID: 'abc123' }] }),
    );
    expect(said).toContain('config.colour: is not one this call takes.');
    expect(said).toContain('which may be what config.targets.0.resourceUUID meant');
  });

  it('is refused on a binding PATCH, in one sentence per stray field', () => {
    const said = patchRefusal('coolify', {
      targets: [{ ...target, healthURL: 'https://x.example.com/health' }],
    });
    expect(said).toBe(
      'The field config.targets.0.healthURL is not one this call takes. This call takes config.targets.0.healthUrl, which may be what config.targets.0.healthURL meant.',
    );
  });

  it('is refused on a connection PATCH, with nothing near it named alone', () => {
    expect(patchRefusal('coolify', { colour: 'red' }, true)).toBe(
      'The field config.colour is not one this call takes.',
    );
  });

  it('names a slip of case in a required field rather than only calling it missing', () => {
    const said = patchRefusal('coolify', { baseurl: 'https://coolify.example.com' }, true);
    expect(said).toContain('The field config.baseurl is not one this call takes.');
    expect(said).toContain('This call takes config.baseUrl');
  });

  it('is refused inside a release verify probe', () => {
    const said = patchRefusal('coolify', {
      verify: { probes: [{ url: 'https://x.example.com/v', commitpath: 'sha' }] },
    });
    expect(said).toContain('config.verify.probes.0.commitPath');
  });

  it('is refused by every provider, its config, its PATCH and its secrets alike', () => {
    for (const decl of listIntegrations()) {
      if (decl.provider === 'agent') continue;
      const { schemas } = decl;
      for (const [name, schema] of Object.entries({
        bindingConfig: schemas.bindingConfig,
        patchConfig: schemas.patchConfig,
        connectionPatchConfig: schemas.connectionPatchConfig,
        secrets: schemas.secrets,
        patchSecrets: schemas.patchSecrets,
      })) {
        const r = schema.safeParse({ zzStray: 1 });
        const refusedByName =
          !r.success &&
          r.error.issues.some(
            (i) =>
              (i.code === 'unrecognized_keys' && i.keys.includes('zzStray')) ||
              String(i.message).includes('zzStray'),
          );
        expect(refusedByName, `${decl.provider} ${name} drops a field it does not take`).toBe(true);
      }
    }
  });

  it('lists the values an enum takes where its refusal says they are listed', () => {
    const schema = configSchemaForProvider('postman');
    const sent = { region: 'asia' };
    const r = schema.safeParse(sent);
    if (r.success) throw new Error('expected the region to be refused');
    const refused = providerHalfRefused(r.error, schema, 'config', sent);
    expect(refused.message).toContain('details.accepted');
    expect((refused.cause as { details: { accepted?: unknown } }).details.accepted).toEqual({
      'config.region': ['us', 'eu'],
    });
  });

  it('still takes every field the provider names', () => {
    const r = configSchemaForProvider('coolify').safeParse({
      targets: [{ ...target, healthUrl: 'https://x.example.com/health' }],
      verify: { probes: [{ url: 'https://x.example.com/v', commitPath: 'sha' }] },
    });
    expect(r.success).toBe(true);
  });
});

// ISS-1421 r29: the creates refused a key to a provider that keeps none in their strict schema's
// words, the PATCH in its own, and an empty set of keys was taken 200 at the PATCH.
describe('a key sent to a provider that keeps none', () => {
  const keyless = listIntegrations().find((d) => !d.schemas.primaryCredentialField)?.provider;
  if (!keyless) throw new Error('no provider keeps no key');

  const createWords = (
    schema: typeof createSchema | typeof connectionCreateSchema,
    body: unknown,
  ) => {
    const r = schema.safeParse(body);
    if (r.success) throw new Error('expected the create body to be refused');
    return schemaRefusalWords(r.error.issues, {
      valuesAre: 'listed in details.accepted',
      input: body,
    }).sentences.join(' ');
  };

  it.each([{ token: 'x' }, {}])('is refused at both creates in the one sentence: %j', (secrets) => {
    const project = { provider: keyless, role: 'deploy', stages: ['live'], secrets };
    expect(createWords(createSchema, project)).toBe(noKeyToSaveMessage(keyless));
    expect(createWords(connectionCreateSchema, { provider: keyless, secrets })).toBe(
      noKeyToSaveMessage(keyless),
    );
  });

  it('takes a create that sends no key', () => {
    expect(
      createSchema.safeParse({ provider: keyless, role: 'deploy', stages: ['live'] }).success,
    ).toBe(true);
    expect(connectionCreateSchema.safeParse({ provider: keyless }).success).toBe(true);
  });

  it.each([{ token: 'x' }, {}])(
    'is refused at a PATCH in the same sentence: %j',
    async (rawSecrets) => {
      const said = await applySecretsPatch({
        provider: keyless,
        rawSecrets,
        connection: {} as IntegrationConnectionRow,
        vaultGuardTiming: 'on-secret-input',
      }).then(
        () => null,
        (err: { status: number; message: string; cause: { details: unknown } }) => err,
      );
      expect(said?.status).toBe(400);
      // The words the error handler answers with, as the HTTP answer carries them.
      expect(refusalMessage(said?.message ?? '', said?.cause.details)).toBe(
        noKeyToSaveMessage(keyless),
      );
    },
  );

  it('names the provider by its label and no field', () => {
    const said = noKeyToSaveMessage(keyless);
    expect(said).toMatch(/^This is the .+ integration, which keeps no key or secret/);
    expect(said).toContain(
      `the ${PROVIDER_LABELS[keyless as keyof typeof PROVIDER_LABELS]} integration`,
    );
    expect(said).not.toContain('secrets');
  });
});

// ISS-1421 r30: a Coolify connection created on its own was refused without `targets`, which
// belong to each project's binding (ISS-1275) and which a project create moves there.
describe("a Coolify connection's own config", () => {
  const conn = (config: Record<string, unknown>) =>
    connectionCreateSchema.safeParse({
      provider: 'coolify',
      config,
      secrets: { apiToken: 'a-coolify-token' },
    });

  it('is taken with its address alone', () => {
    expect(conn({ baseUrl: 'https://coolify.example.com' }).success).toBe(true);
  });

  it('still takes targets for the projects that share it', () => {
    expect(conn({ baseUrl: 'https://coolify.example.com', targets: [target] }).success).toBe(true);
  });

  it("still needs a project's binding to name its targets", () => {
    const project = createSchema.safeParse({
      provider: 'coolify',
      role: 'deploy',
      stages: ['live'],
      config: { baseUrl: 'https://coolify.example.com' },
      secrets: { apiToken: 'a-coolify-token' },
    });
    expect(project.success).toBe(false);
  });
});

// ISS-1421 r30: a storefront label was refused "label must be kebab-case (a-z0-9-)".
describe('a storefront label the create refuses', () => {
  it('says what a label takes in words a person reads', () => {
    const r = createSchema.safeParse({
      provider: 'epodsystem',
      role: 'service',
      label: 'Partner A',
      secrets: { apiKey: 'crmk_made_up_key_123' },
    });
    expect(r.success).toBe(false);
    const said = r.success ? '' : r.error.issues.map((i) => i.message).join(' ');
    expect(said).toContain(
      'A label takes lowercase letters, numbers and dashes, starting with a letter or number, e.g. partner-a.',
    );
    expect(said).not.toMatch(/kebab/i);
  });
});

// ISS-1421 r31, judge-127 on 348: these named providers by their ids where the page shows labels.
describe('a provider named in a create refusal', () => {
  it('refuses a label on a single-binding provider naming it by its label', () => {
    const said = createRefusal({
      provider: 'google',
      role: 'service',
      label: 'second',
      config: {},
      secrets: {},
    });
    expect(said).toContain(
      'label: Google Sheets connects to a project once, so it takes no label.',
    );
    expect(said).toContain('only Epodsystem can be connected several times');
    expect(said).not.toMatch(/`google`|multiBinding/);
  });

  it('lists the values an unknown provider may be sent as, each beside its label', () => {
    const said = undeclaredProviderMessage('slack');
    expect(said).toMatch(/^`slack` is not an integration this deployment declares\. Send one of /);
    expect(said).toContain('`coolify` (Coolify)');
    expect(said).toContain('`agent` (Agent release channel)');
  });
});
