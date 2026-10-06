import { db, type Tx } from '../db/client.js';
import { permissionFactsOf, permissionRefusal } from '../permissions/index.js';
import { type StaleContractPin, staleOnContract } from '../requirements/index.js';
import { notFound } from './access.js';
import { type AdoptPlan, type AdoptVersion, checkAdopt } from './adopt-rules.js';
import { versionsOf } from './contract/store.js';
import { checkInterface, splitContractRef } from './interface-rules.js';
import {
  buildWorld,
  edgesOf,
  type HeldInterface,
  heldInterface,
  type ProviderWriter,
} from './interface-service.js';
import { putInterface, readInterface } from './interface-store.js';
import { impactLink, storedLink } from './link-service.js';
import { linksWhere, replaceLink, type StoredLink } from './link-store.js';
import type { EcosystemRefusal } from './refusals.js';
import type { InterfaceDocument } from './schema.js';
import { lockKeys, type ProjectRow, projectsWhere } from './store.js';

export type AdoptOutcome =
  | {
      ok: true;
      held: HeldInterface;
      moved: AdoptPlan;
      staleRequirements: StaleContractPin[];
    }
  | { ok: false; refusals: EcosystemRefusal[] };

interface AdoptInput {
  projectId: string;
  writer: ProviderWriter;
  contract: string;
  version: string;
}

const consumedAt = (doc: InterfaceDocument, contract: string) =>
  doc.consumes.flatMap((c, index) =>
    c.contract === contract ? [{ index, builtAgainst: c.builtAgainst }] : [],
  );

async function versionsFor(tx: Tx, provider: ProjectRow, slug: string) {
  const rows = await versionsOf(tx, [provider.id], slug);
  return new Map<string, AdoptVersion>(
    rows.map((v) => [
      v.version,
      {
        approval: v.approval,
        previous: v.document.previous ?? null,
        diff: v.document.diff,
        elements: v.elements ? new Set(v.elements) : null,
      },
    ]),
  );
}

// every link this consumer holds to the contract moves with it, whichever ecosystem it was made in: a link left behind would read as built against a version the interface no longer names
async function linksTo(
  tx: Tx,
  input: { consumer: string; provider: string; slug: string },
): Promise<StoredLink[]> {
  const rows = await linksWhere(tx, { consumerId: input.consumer });
  return rows.filter(
    (l) => l.providerProjectId === input.provider && l.contractSlug === input.slug,
  );
}

async function writeAdopt(
  tx: Tx,
  input: AdoptInput & {
    self: ProjectRow;
    current: HeldInterface;
    plan: AdoptPlan;
    rows: StoredLink[];
  },
): Promise<EcosystemRefusal[] | HeldInterface> {
  const { self, current, plan, version, writer } = input;
  const moving = new Set(plan.consumptions.map((c) => c.index));
  const doc: InterfaceDocument = {
    ...current.document,
    consumes: current.document.consumes.map((c, i) =>
      moving.has(i) ? { ...c, builtAgainst: version } : c,
    ),
  };
  const slugs = [...new Set(doc.consumes.map((c) => splitContractRef(c.contract).provider))];
  const providers = (await projectsWhere(tx, { slugs })).filter((p) => p.id !== self.id);
  const touched = (path: string) =>
    [...moving].some((i) => path === `/consumes/${i}` || path.startsWith(`/consumes/${i}/`));
  const refusals = checkInterface(doc, await buildWorld(tx, self, providers)).filter((r) =>
    touched(r.path),
  );
  if (refusals.length > 0) return refusals;
  const linkIds = new Set(plan.links.map((l) => l.id));
  for (const row of input.rows.filter((r) => linkIds.has(r.id))) {
    const next = { ...storedLink(row), pinnedVersion: version };
    await replaceLink(tx, { id: row.id, revision: row.revision, doc: next, userId: writer.userId });
  }
  if (moving.size === 0) return current;
  const row = await putInterface(
    tx,
    { projectId: self.id, revision: current.revision + 1, userId: writer.userId },
    doc,
    edgesOf(doc, self.id, providers),
  );
  return heldInterface(row, self.id);
}

/**
 * Moves a consumer to an additive version of a contract it consumes in one transaction: the
 * interface revision naming it as `builtAgainst`, and each link's `pinnedVersion` (feedback-triage
 * `breaking`). The requirements built on that contract are named, never re-pinned: a re-pin is a
 * baseline, which a holder of requirements.approve signs.
 */
export async function adoptVersion(input: AdoptInput): Promise<AdoptOutcome> {
  const { projectId, writer, contract, version } = input;
  const denied = permissionRefusal(
    await permissionFactsOf(writer.userId, projectId),
    'project.write',
    'adopting a contract version',
  );
  if (denied) return { ok: false, refusals: [denied] };
  const [self] = await projectsWhere(db, { ids: [projectId] });
  if (!self) throw notFound(`project ${projectId} does not exist`);
  const ref = splitContractRef(contract);
  const [provider] = await projectsWhere(db, { slugs: [ref.provider] });
  const outcome = await db.transaction(async (tx) => {
    await lockKeys(tx, [
      `project:${self.id}`,
      ...(provider ? [`project:${provider.id}`] : []),
      `link:${self.id}`,
    ]);
    const stored = await readInterface(tx, projectId);
    const current = stored ? heldInterface(stored, projectId) : null;
    const consumed = current ? consumedAt(current.document, contract) : [];
    const rows =
      provider && consumed.length > 0
        ? await linksTo(tx, {
            consumer: self.id,
            provider: provider.id,
            slug: ref.contract,
          })
        : [];
    const providerDoc = provider ? await readInterface(tx, provider.id) : null;
    const checked = checkAdopt({
      contract,
      version,
      versioning:
        provider && providerDoc
          ? heldInterface(providerDoc, provider.id).document.commitments.versioning
          : 'dated',
      consumed,
      versions: provider ? await versionsFor(tx, provider, ref.contract) : new Map(),
      links: rows.map(impactLink),
    });
    if (!checked.ok) return checked;
    if (!current || !provider) throw new Error('ecosystem: an adopt passed with no consumption');
    const written = await writeAdopt(tx, { ...input, self, current, plan: checked.plan, rows });
    if (Array.isArray(written)) return { ok: false as const, refusals: written };
    return { ok: true as const, held: written, moved: checked.plan, provider };
  });
  if (!outcome.ok) return outcome;
  const staleRequirements = await staleOnContract({
    projectId,
    providerProjectId: outcome.provider.id,
    contractSlug: ref.contract,
  });
  return { ok: true, held: outcome.held, moved: outcome.moved, staleRequirements };
}
