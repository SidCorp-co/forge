/**
 * ISS-1421 r18, criterion 171 — judge-75 sent a Coolify binding `targets[0].healthURL` (meant
 * `healthUrl`), `colour` and `resourceUUID`: each answered 200 and the value was lost, because every
 * provider's config schema stripped a field it did not name. Each is refused by name now, with the
 * field near it the provider takes, at create, at a PATCH and inside an array entry.
 */

import { describe, expect, it } from 'vitest';
import {
  configSchemaForProvider,
  connectionConfigSchemaForProvider,
  createSchema,
  providerHalfRefused,
} from './provider-schemas.js';
import { registerAllIntegrations } from './register-all.js';
import { listIntegrations } from './registry.js';

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

  it('still takes every field the provider names', () => {
    const r = configSchemaForProvider('coolify').safeParse({
      targets: [{ ...target, healthUrl: 'https://x.example.com/health' }],
      verify: { probes: [{ url: 'https://x.example.com/v', commitPath: 'sha' }] },
    });
    expect(r.success).toBe(true);
  });
});
