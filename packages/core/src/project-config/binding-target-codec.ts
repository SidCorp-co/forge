import type { StoredBinding } from './binding-store.js';
import { isRecord } from './documents.js';
import { type BindingDocument, bindingDocumentSchema } from './schema.js';

export type Target = BindingDocument['target'];

interface Encoded {
  provider: string;
  label: string;
  config: Record<string, unknown>;
}

// cm:edge contract -> packages/core/src/integrations/provider-schemas.ts — each provider's binding-tier
// config keys (`bindingConfigKeys`) other than the release channel's, which the target names alike.
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  coolify: ['targets'],
  shopify: ['store', 'themeRole'],
  epodsystem: [],
  autoflow: ['shop'],
  github: ['installationId', 'owner', 'repo'],
  gitlab: ['projectPath', 'projectId'],
  sentry: [],
  rocketchat: ['rids'],
  google: ['defaultSpreadsheetId'],
  agent: [],
};

const RELEASE_RUNNER_LABEL = 'releaseRunnerLabel';

const ROLLBACK_MOVED_TO =
  "the project document's `rollback.strategy` (`PUT /api/projects/:id/config`)";

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

export function encodeTarget(target: Target): Encoded {
  const { provider, label, releaseRunnerLabel, ...rest } = target;
  const config =
    target.provider === 'coolify'
      ? {
          targets: target.applications.map((a) => ({
            id: a.id ?? a.label,
            label: a.label,
            resourceUuid: a.resourceUuid,
            ...(a.healthUrl ? { healthUrl: a.healthUrl } : {}),
          })),
        }
      : pick(rest as Record<string, unknown>, FIELDS[provider] ?? []);
  return {
    provider,
    label: label ?? '',
    config: releaseRunnerLabel ? { ...config, [RELEASE_RUNNER_LABEL]: releaseRunnerLabel } : config,
  };
}

export type Decoded =
  | { ok: true; target: Target }
  | { ok: false; reason: string; wouldDrop: boolean };

function applicationsOf(targets: unknown): unknown {
  if (!Array.isArray(targets)) return targets;
  return targets.map((t) =>
    isRecord(t)
      ? {
          ...(typeof t.id === 'string' && t.id !== t.label ? { id: t.id } : {}),
          label: t.label,
          resourceUuid: t.resourceUuid,
          ...(t.healthUrl === undefined ? {} : { healthUrl: t.healthUrl }),
        }
      : t,
  );
}

export function decodeTarget(row: Pick<StoredBinding, 'provider' | 'config' | 'label'>): Decoded {
  const config = isRecord(row.config) ? row.config : {};
  const fields = FIELDS[row.provider];
  if (!fields) {
    return {
      ok: false,
      reason: `binding-v1 defines no target for provider "${row.provider}"`,
      wouldDrop: true,
    };
  }
  if ('rollback' in config) {
    return {
      ok: false,
      reason: `this ${row.provider} binding still holds a \`rollback\`, which binding-v1 removed: how a release is undone is ${ROLLBACK_MOVED_TO}. The stored text is kept for the read-only export (ISS-16)`,
      wouldDrop: true,
    };
  }
  const unheld = Object.keys(config).filter(
    (k) => k !== RELEASE_RUNNER_LABEL && !fields.includes(k),
  );
  if (unheld.length > 0) {
    return {
      ok: false,
      reason: `this ${row.provider} binding also holds ${unheld.map((k) => `\`${k}\``).join(', ')}, which a binding document has no field for; writing it back as a document would drop ${unheld.length === 1 ? 'it' : 'them'}`,
      wouldDrop: true,
    };
  }
  const candidate = {
    provider: row.provider,
    ...(row.provider === 'coolify'
      ? { applications: applicationsOf(config.targets) }
      : pick(config, fields)),
    ...(row.label ? { label: row.label } : {}),
    ...(config[RELEASE_RUNNER_LABEL] === undefined
      ? {}
      : { releaseRunnerLabel: config[RELEASE_RUNNER_LABEL] }),
  };
  const parsed = bindingDocumentSchema.shape.target.safeParse(candidate);
  if (!parsed.success) {
    const said = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'target'}: ${i.message}`)
      .join('; ');
    return {
      ok: false,
      reason: `this ${row.provider} binding is not a binding-v1 target (${said})`,
      wouldDrop: false,
    };
  }
  return { ok: true, target: parsed.data };
}
