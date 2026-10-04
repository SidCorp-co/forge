import { and, eq } from 'drizzle-orm';
import { mergeSessionMetadata } from '../../agent-sessions/index.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { heldInterface } from '../interface-service.js';
import { readInterfaces } from '../interface-store.js';
import { storedLink } from '../link-service.js';
import { linksWhere } from '../link-store.js';
import {
  type ContextLink,
  type ContextVersion,
  contractContext,
  contractContextRecord,
  type LoadedContract,
} from './run-context.js';
import { versionsOf } from './store.js';

const CONTRACT_CONTEXT_KEY = 'contractContext';

/** The contracts a consumer project's run reaches through `paths`: guide + pinned→latest diff per link. */
export async function loadContractContext(
  projectId: string,
  paths: readonly string[],
): Promise<LoadedContract[]> {
  if (paths.length === 0) return [];
  const rows = await linksWhere(db, { consumerId: projectId });
  if (rows.length === 0) return [];
  const links: ContextLink[] = rows.map((r) => {
    const doc = storedLink(r);
    return {
      id: r.id,
      provider: r.providerProjectId,
      contractSlug: r.contractSlug,
      pinnedVersion: r.pinnedVersion,
      callSites: doc.callSites,
      notes: doc.notes,
    };
  });
  const providers = [...new Set(links.map((l) => l.provider))];
  const [versions, interfaces] = await Promise.all([
    versionsOf(db, providers),
    readInterfaces(db, providers),
  ]);
  const byContract = new Map<string, ContextVersion[]>();
  // cm:why a run is moved only through versions that are current or were: a proposed or returned version is no one's contract yet (ISS-60)
  for (const v of versions.filter((x) => x.approval === 'approved')) {
    const key = `${v.providerProjectId}/${v.contractSlug}`;
    byContract.set(key, [
      ...(byContract.get(key) ?? []),
      { version: v.version, changes: v.document.diff.changes },
    ]);
  }
  return contractContext({
    paths,
    links,
    versionsOf: (l) => byContract.get(`${l.provider}/${l.contractSlug}`) ?? [],
    versioningOf: (l) => {
      const i = interfaces.get(l.provider);
      return i ? heldInterface(i, l.provider).document.commitments.versioning : 'dated';
    },
  });
}

/** Stamps the load on the session's metadata, merged so no other key is touched. */
export async function recordContractContext(
  agentSessionId: string,
  loaded: readonly LoadedContract[],
  source: string,
): Promise<void> {
  await mergeSessionMetadata(agentSessionId, {
    [CONTRACT_CONTEXT_KEY]: contractContextRecord(loaded, source),
  });
}

/** Whether `projectId` holds the agent session `id`, so a load is recorded only on its own project's session. */
export async function sessionInProject(projectId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.projectId, projectId)))
    .limit(1);
  return Boolean(row);
}
