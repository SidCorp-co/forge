import type { BindingTargetRefusal, VerifyBindingTargetArgs } from '../../index.js';
import { decryptConnectionSecrets, type IntegrationConnectionRow } from '../../index.js';
import { credentialFromSecrets, fetchCoolifyApplications } from './applications.js';
import { CoolifyApiError, describeCoolifyForbidden } from './client.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

function uuidsOf(config: Record<string, unknown> | null): string[] {
  const targets = Array.isArray(config?.targets) ? config.targets : [];
  return targets.map((t) => String((t as { resourceUuid?: unknown }).resourceUuid ?? ''));
}

function unreachable(detail: string): BindingTargetRefusal[] {
  return [
    {
      code: 'COOLIFY_UNREACHABLE',
      path: '/applications',
      detail: `${detail}; nothing was written, because an application Coolify has not confirmed is never stored.`,
    },
  ];
}

export async function verifyCoolifyBindingTarget({
  connection,
  config,
  held,
}: VerifyBindingTargetArgs): Promise<BindingTargetRefusal[]> {
  const already = new Set(uuidsOf(held));
  const fresh = uuidsOf(config)
    .map((uuid, index) => ({ uuid, index }))
    .filter(({ uuid }) => !already.has(uuid));
  if (fresh.length === 0) return [];

  const connConfig = (connection.config ?? {}) as Partial<CoolifyConfig>;
  const secrets = decryptConnectionSecrets<CoolifySecrets>(connection as IntegrationConnectionRow);
  if (!connConfig.baseUrl || !secrets.apiToken) {
    return unreachable('the connection holds no Coolify base URL or API token to ask Coolify with');
  }
  let known: Set<string>;
  try {
    const apps = await fetchCoolifyApplications(
      credentialFromSecrets(connConfig as CoolifyConfig, secrets),
    );
    known = new Set(apps.map((a) => a.uuid));
  } catch (err) {
    const why =
      err instanceof CoolifyApiError && err.status === 403
        ? describeCoolifyForbidden(err)
        : err instanceof Error
          ? err.message
          : String(err);
    return unreachable(
      `Coolify at ${connConfig.baseUrl} could not be asked which applications exist (${why})`,
    );
  }
  return fresh
    .filter(({ uuid }) => !known.has(uuid))
    .map(({ uuid, index }) => ({
      code: 'COOLIFY_APPLICATION_UNKNOWN' as const,
      path: `/applications/${index}/resourceUuid`,
      detail: `Coolify at ${connConfig.baseUrl} has no application "${uuid}" that this connection's token can see; copy the uuid from the application's page in Coolify.`,
    }));
}
