// A production environment a suite can release onto, declared the way ISS-12 reads it: a deploy
// binding, and a project document whose production environment names it.

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { vi } from 'vitest';
import type { ProjectDocument } from '../../src/project-config/schema.js';
import type { TestDb } from './db.js';
import { seedProjectDocument } from './factories.js';

type Environments = ProjectDocument['environments'];
type Environment = Environments[string];

/** What production's `verification.runtime` declares. */
export type DeclaredProbes = 'source' | 'none' | 'artifact-only';

export interface SeedProduction {
  projectId: string;
  ownerId: string;
  provider?: string;
  /** The binding's own config: targets, releaseRunnerLabel, rollback. */
  config?: Record<string, unknown>;
  connectionConfig?: Record<string, unknown>;
  /** Encrypted secrets for the connection, where the suite reaches the provider. */
  secretsEnc?: string | null;
  label?: string;
  probes?: DeclaredProbes;
  /** An https url; `stubProbe` answers it. */
  probeUrl?: string;
  /** The JSON path the probe's commit is read at. */
  probePath?: string;
  trigger?: 'on-land' | 'on-request' | 'provider';
  /** The branch production deploys from; a promotion from `main` is declared when it differs. */
  deploysFrom?: string;
  name?: string;
  /** Other environments of the document, beside production. */
  others?: Environments;
  /** Where the project's work lands; git unless a suite is about a storefront. */
  sourceType?: 'git' | 'storefront';
}

export const PRODUCTION_PROBE = 'https://production.example.test/version';

/** Inserts a connection and a deploy binding, and the project document naming it as production. */
export async function seedProduction(
  db: TestDb,
  opts: SeedProduction,
): Promise<{ bindingId: string; connectionId: string }> {
  const provider = opts.provider ?? 'coolify';
  const connectionId = randomUUID();
  const bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, config, secrets_enc, active)
    VALUES (${connectionId}, 'user', ${opts.ownerId}, ${provider},
            ${JSON.stringify(opts.connectionConfig ?? {})}::jsonb, ${opts.secretsEnc ?? null}, true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, label, active, config)
    VALUES (${bindingId}, ${connectionId}, ${opts.projectId}, ${provider}, 'deploy',
            ${opts.label ?? ''}, true, ${JSON.stringify(opts.config ?? {})}::jsonb)
  `);
  await declareProductionDocument(db, { ...opts, bindingId });
  return { bindingId, connectionId };
}

/** The project document alone: production deploys through `bindingId`. */
export async function declareProductionDocument(
  db: TestDb,
  opts: Omit<
    SeedProduction,
    'provider' | 'config' | 'connectionConfig' | 'secretsEnc' | 'label'
  > & {
    bindingId: string;
  },
): Promise<void> {
  const deploysFrom = opts.deploysFrom ?? 'main';
  const url = opts.probeUrl ?? PRODUCTION_PROBE;
  const path = opts.probePath ?? 'commit';
  const probes = opts.probes ?? 'source';
  const verification =
    probes === 'none'
      ? {}
      : {
          verification: {
            runtime: [
              {
                type: 'http' as const,
                url,
                path,
                identifies: probes === 'source' ? ('source' as const) : ('artifact' as const),
              },
            ],
          },
        };
  const production: Environment = {
    tier: 'production',
    deploysFrom,
    deployment: { binding: opts.bindingId, trigger: opts.trigger ?? 'on-request' },
    ...verification,
  };
  await seedProjectDocument(db, opts.projectId, opts.ownerId, {
    defaultBranch: 'main',
    promotions: deploysFrom === 'main' ? [] : [{ from: 'main', to: deploysFrom, via: 'merge' }],
    environments: { ...(opts.others ?? {}), [opts.name ?? 'live']: production },
    ...(opts.sourceType ? { sourceType: opts.sourceType } : {}),
  });
}

/**
 * Answers each https probe url with what `answer` says, passing every other request through.
 * A suite whose probe was a local http server forwards to it: `stubProbe({ [url]: localUrl })`.
 */
export function stubProbe(answers: Record<string, string | (() => Response | Promise<Response>)>) {
  const passThrough = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: URL | string | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const answer = answers[url.split('?')[0] ?? url];
    if (answer === undefined) return passThrough(input, init);
    return typeof answer === 'string' ? passThrough(answer, init) : answer();
  });
}

/**
 * Runs `act` on a clock that gains a minute every time it is read, so a release verification that
 * never confirms reaches the end of its 300 s window in a few reads instead of waiting it out:
 * project-v1 declares no window of its own.
 */
export async function pastTheProbeWindow<T>(act: () => T | Promise<T>): Promise<T> {
  const realNow = Date.now.bind(Date);
  let reads = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
    reads += 1;
    return realNow() + 60_000 * reads;
  });
  try {
    return await act();
  } finally {
    clock.mockRestore();
  }
}
