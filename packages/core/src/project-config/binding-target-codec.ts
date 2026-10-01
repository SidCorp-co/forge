import type { StoredBinding } from './binding-store.js';
import { type ApiRefusal, isRecord } from './documents.js';
import type { BindingDocument } from './schema.js';

export type Target = BindingDocument['target'];

export type Encoded =
  | { ok: true; provider: string; config: Record<string, unknown> }
  | { ok: false; refusal: ApiRefusal };

export function encodeTarget(target: Target): Encoded {
  switch (target.provider) {
    case 'coolify':
      return {
        ok: true,
        provider: 'coolify',
        config: {
          targets: [{ id: 'primary', label: 'primary', resourceUuid: target.applicationUuid }],
        },
      };
    case 'shopify':
      return {
        ok: true,
        provider: 'shopify',
        config: {
          store: target.store,
          ...(target.themeRole === undefined ? {} : { themeRole: target.themeRole }),
        },
      };
    case 'epodsystem':
      return {
        ok: false,
        refusal: {
          code: 'BINDING_TARGET_UNSUPPORTED',
          path: '/target/provider',
          detail:
            'an epodsystem binding keeps its store in the connection and in the binding label, and no mapping from a binding document onto those is decided; bind an epodsystem store through /api/projects/:id/integrations.',
        },
      };
  }
}

export type Decoded = { ok: true; target: Target } | { ok: false; reason: string };

const REPRESENTED: Readonly<Record<string, readonly string[]>> = {
  coolify: ['targets'],
  shopify: ['store', 'themeRole'],
};

export function decodeTarget(row: Pick<StoredBinding, 'provider' | 'config'>): Decoded {
  const config = isRecord(row.config) ? row.config : {};
  const represented = REPRESENTED[row.provider];
  const unheld = represented ? Object.keys(config).filter((k) => !represented.includes(k)) : [];
  if (unheld.length > 0) {
    return {
      ok: false,
      reason: `this ${row.provider} binding also holds ${unheld.map((k) => `\`${k}\``).join(', ')}, which a binding document has no field for; writing it back as a document would drop ${unheld.length === 1 ? 'it' : 'them'}`,
    };
  }
  if (row.provider === 'coolify') {
    const targets = Array.isArray(config.targets) ? config.targets : [];
    const [only] = targets;
    if (targets.length === 1 && isRecord(only) && typeof only.resourceUuid === 'string') {
      return { ok: true, target: { provider: 'coolify', applicationUuid: only.resourceUuid } };
    }
    return {
      ok: false,
      reason: `a coolify binding document names one application, and this row names ${targets.length} deploy targets`,
    };
  }
  if (row.provider === 'shopify' && typeof config.store === 'string') {
    const themeRole = config.themeRole;
    if (themeRole !== undefined && themeRole !== 'main' && themeRole !== 'unpublished') {
      return {
        ok: false,
        reason: `themeRole ${JSON.stringify(themeRole)} is not main or unpublished`,
      };
    }
    return {
      ok: true,
      target: { provider: 'shopify', store: config.store, ...(themeRole ? { themeRole } : {}) },
    };
  }
  return {
    ok: false,
    reason: `a ${row.provider} binding row has no binding-document form; it was written through the integrations routes`,
  };
}
