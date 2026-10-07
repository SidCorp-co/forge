import {
  decryptConnectionSecrets,
  type IntegrationConnectionRow,
  type ReportedIdentityBinding,
  raceWithTimeout,
} from '../../index.js';
import { credentialFromSecrets, fetchCoolifyApplications } from './applications.js';
import type { CoolifyConfig, CoolifySecrets } from './types.js';

const ASK_TIMEOUT_MS = 3_000;
const ANSWER_KEPT_MS = 5 * 60_000;
const SILENCE_KEPT_MS = 60_000;

type AppNames = ReadonlyMap<string, string>;

const asked = new Map<string, { until: number; names: AppNames | null }>();

function uuidsOf(config: Record<string, unknown>): string[] {
  const targets = Array.isArray(config.targets) ? config.targets : [];
  return targets.flatMap((t) => {
    const uuid = (t as { resourceUuid?: unknown } | null)?.resourceUuid;
    return typeof uuid === 'string' && uuid.length > 0 ? [uuid] : [];
  });
}

/** Every application name the connection's token can see, by uuid; null where Coolify does not answer. */
async function askCoolify(binding: ReportedIdentityBinding): Promise<AppNames | null> {
  const baseUrl = binding.config.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null;
  let auth: ReturnType<typeof credentialFromSecrets>;
  try {
    auth = credentialFromSecrets(
      { baseUrl } as CoolifyConfig,
      decryptConnectionSecrets<CoolifySecrets>(binding.connection as IntegrationConnectionRow),
    );
  } catch {
    return null;
  }
  if (!auth.apiToken) return null;
  const apps = await raceWithTimeout(fetchCoolifyApplications(auth), ASK_TIMEOUT_MS).catch(
    () => null,
  );
  if (!apps) return null;
  return new Map(apps.flatMap((a) => (a.name ? [[a.uuid, a.name] as const] : [])));
}

async function namesFor(binding: ReportedIdentityBinding, now: number): Promise<AppNames | null> {
  const held = asked.get(binding.connection.id);
  if (held && held.until > now) return held.names;
  const names = await askCoolify(binding);
  asked.set(binding.connection.id, {
    until: now + (names ? ANSWER_KEPT_MS : SILENCE_KEPT_MS),
    names,
  });
  return names;
}

/**
 * The name Coolify itself gives each binding's application, asked once per connection and kept for
 * five minutes (a minute when Coolify did not answer). A binding whose every target Coolify names
 * reads as those names; one it cannot name is left out, so its config names it instead.
 */
export async function coolifyApplicationNames(
  bindings: readonly ReportedIdentityBinding[],
): Promise<Map<string, string>> {
  const now = Date.now();
  const byConnection = new Map<string, ReportedIdentityBinding[]>();
  for (const b of bindings) {
    byConnection.set(b.connection.id, [...(byConnection.get(b.connection.id) ?? []), b]);
  }
  const out = new Map<string, string>();
  await Promise.all(
    [...byConnection.values()].map(async (rows) => {
      const names = await namesFor(rows[0] as ReportedIdentityBinding, now);
      if (!names) return;
      for (const row of rows) {
        const uuids = uuidsOf(row.config);
        const named = uuids.map((u) => names.get(u));
        if (uuids.length > 0 && named.every((n): n is string => n !== undefined)) {
          out.set(row.id, named.join(', '));
        }
      }
    }),
  );
  return out;
}
