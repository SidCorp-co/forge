import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { issueDisplayIds } from '../../issues/display-ids.js';
import { reportedCommit } from '../../release-batch/verify.js';
import { heldEcosystem } from '../ecosystem-service.js';
import { loadInterface } from '../interface-service.js';
import { activeEcosystemIdsOf, readEcosystems } from '../store.js';
import { type LiveShortfall, providerLiveMode, providerLiveShortfall } from './rules.js';

export interface ProviderLive {
  version: string | null;
  serving: string | null;
}

// cm:why a version is live where the commit production last verifiably served is the land it was measured at, or the land that found the artifact unchanged since; a release with no source probe, an uploaded version or a stale land places none, and none is a refusal, never a guess
export async function providerLiveVersion(
  providerId: string,
  contractSlug: string,
): Promise<ProviderLive> {
  const served = (await db.execute(sql`
    SELECT a.identity FROM release_attempts a
    JOIN pipeline_runs r ON r.id = a.run_id
    WHERE r.project_id = ${providerId}
      AND a.verdict = 'ok' AND a.identity IS NOT NULL AND a.settled_at IS NOT NULL
    ORDER BY a.settled_at DESC LIMIT 1
  `)) as unknown as Array<{ identity: string }>;
  const reading = served[0] ? reportedCommit(served[0].identity) : null;
  if (!reading) return { version: null, serving: null };
  const rows = (await db.execute(sql`
    SELECT v.version FROM contract_measurements m
    JOIN LATERAL (
      SELECT cv.version FROM contract_versions cv
      WHERE cv.provider_project_id = m.provider_project_id
        AND cv.contract_slug = m.contract_slug
        AND cv.recorded_at <= m.settled_at
      ORDER BY cv.recorded_at DESC LIMIT 1
    ) v ON true
    WHERE m.provider_project_id = ${providerId}
      AND m.contract_slug = ${contractSlug}
      AND m.outcome IN ('recorded', 'unchanged')
      AND m.commit_sha LIKE ${`${reading}%`}
    ORDER BY m.observed_at DESC LIMIT 1
  `)) as unknown as Array<{ version: string }>;
  return { version: rows[0]?.version ?? null, serving: reading };
}

interface LiveWaitRow {
  issue_id: string;
  project_id: string;
  provider_project_id: string;
  provider_slug: string;
  contract_slug: string;
  min_version: string;
}

async function modeFor(consumerId: string, published: readonly string[]) {
  const active = (await activeEcosystemIdsOf(db, [consumerId])).map((m) => m.ecosystemId);
  const shared = published.filter((e) => active.includes(e));
  const ecos = await readEcosystems(db, shared);
  return providerLiveMode(ecos.map((e) => heldEcosystem(e).document.releases?.providerLive));
}

export async function contractProviderShortfalls(
  issueIds: readonly string[],
): Promise<LiveShortfall[]> {
  if (issueIds.length === 0) return [];
  const list = sql.join(
    issueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const waits = (await db.execute(sql`
    SELECT cw.issue_id, cw.project_id, cw.provider_project_id, p.slug AS provider_slug,
           cw.contract_slug, cw.min_version
    FROM issue_contract_waits cw
    JOIN projects p ON p.id = cw.provider_project_id
    WHERE cw.issue_id IN (${list}) AND cw.retracted_at IS NULL
    ORDER BY cw.created_at
  `)) as unknown as LiveWaitRow[];
  if (waits.length === 0) return [];
  const shown = await issueDisplayIds(waits.map((w) => w.issue_id));
  const out: LiveShortfall[] = [];
  for (const w of waits) {
    const iface = await loadInterface(w.provider_project_id);
    const published = iface?.document.publishes[w.contract_slug]?.ecosystems ?? [];
    const short = providerLiveShortfall({
      issueId: w.issue_id,
      issue: shown.get(w.issue_id) ?? w.issue_id,
      contract: `${w.provider_slug}/${w.contract_slug}`,
      minVersion: w.min_version,
      versioning: iface?.document.commitments.versioning ?? null,
      live: (await providerLiveVersion(w.provider_project_id, w.contract_slug)).version,
      mode: await modeFor(w.project_id, published),
    });
    if (short) out.push(short);
  }
  return out;
}
