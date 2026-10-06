import { randomUUID } from 'node:crypto';
import { isPlainObject as isRecord } from '@forge/contracts/document-patch';
import { db, type Tx } from '../db/client.js';
import { parseVersionedDocument, staleBase } from '../project-config/index.js';
import { assertStewardAdmin, notFound } from './access.js';
import { checkEcosystem, type MemberCommitment } from './ecosystem-rules.js';
import type { Checked, EcosystemRefusal } from './refusals.js';
import {
  type EcosystemDocument,
  ecosystemDocumentSchema,
  ecosystemWriteSchema,
  type InterfaceDocument,
  interfaceDocumentSchema,
} from './schema.js';
import {
  activeMemberInterfaces,
  ecosystemHolding,
  lockKeys,
  numbersReserved,
  putEcosystem,
  readEcosystem,
  type StoredEcosystem,
} from './store.js';

export interface HeldEcosystem {
  id: string;
  stewardOrgId: string;
  revision: number;
  document: EcosystemDocument;
  updatedBy: string;
  updatedAt: Date;
}

export type EcosystemOutcome =
  | { ok: true; held: HeldEcosystem; created: boolean }
  | { ok: false; refusals: EcosystemRefusal[] };

export function storedAs<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  document: unknown,
  what: string,
): T {
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `ecosystem: the stored ${what} no longer parses as version 1; the store holds a shape this core cannot read and it is not guessed at.`,
    );
  }
  return parsed.data;
}

export function heldEcosystem(row: StoredEcosystem): HeldEcosystem {
  return {
    ...row,
    document: storedAs(ecosystemDocumentSchema, row.document, `ecosystem ${row.id}`),
  };
}

export async function loadEcosystem(id: string): Promise<HeldEcosystem> {
  const row = await readEcosystem(db, id);
  if (!row) throw notFound(`ecosystem ${id} does not exist`);
  return heldEcosystem(row);
}

// one rule for the id in both directions: core assigns it, so a create names none and an update names exactly the one core assigned; anything else is ECOSYSTEM_ID_IMMUTABLE
function parseEcosystem(raw: unknown, id: string, creating: boolean): Checked<EcosystemDocument> {
  const claimed = isRecord(raw) && isRecord(raw.ecosystem) ? raw.ecosystem.id : undefined;
  if (creating && claimed !== undefined) {
    return {
      ok: false,
      refusals: [
        {
          code: 'ECOSYSTEM_ID_IMMUTABLE',
          path: '/ecosystem/id',
          detail:
            'core assigns an ecosystem its id; leave ecosystem.id out of the document you create.',
        },
      ],
    };
  }
  if (!creating && claimed !== id) {
    return {
      ok: false,
      refusals: [
        {
          code: 'ECOSYSTEM_ID_IMMUTABLE',
          path: '/ecosystem/id',
          detail:
            claimed === undefined
              ? `an update names the id core assigned; send ecosystem.id ${id}, the document at /api/ecosystems/${id}.`
              : `ecosystem.id ${JSON.stringify(claimed)} is not this ecosystem; the document at /api/ecosystems/${id} names ${id}, which core assigned and never changes.`,
        },
      ],
    };
  }
  const parsed = parseVersionedDocument(ecosystemWriteSchema, raw, 'ecosystem');
  if (!parsed.ok) return { ok: false, refusals: parsed.refusals };
  return { ok: true, value: { ...parsed.value, ecosystem: { ...parsed.value.ecosystem, id } } };
}

async function commitments(tx: Tx, ecosystemId: string): Promise<MemberCommitment[]> {
  const rows = await activeMemberInterfaces(tx, ecosystemId);
  return rows.map((r) => ({
    projectSlug: r.projectSlug,
    responseDays: storedAs<InterfaceDocument>(
      interfaceDocumentSchema,
      r.document,
      `interface of ${r.projectSlug}`,
    ).commitments.responseDays,
  }));
}

async function store(input: {
  id: string;
  document: EcosystemDocument;
  baseRevision: number | null;
  userId: string;
}): Promise<EcosystemOutcome> {
  const { id, document, baseRevision, userId } = input;
  return db.transaction(async (tx) => {
    await lockKeys(tx, [
      `ecosystem:${id}`,
      `slug:${document.ecosystem.slug}`,
      `code:${document.channel.code}`,
    ]);
    const current = await readEcosystem(tx, id);
    const storedRevision = current?.revision ?? null;
    if (storedRevision !== baseRevision) {
      return { ok: false, refusals: [staleBase(baseRevision, storedRevision)] };
    }
    const refusals = checkEcosystem(document, {
      current: current ? heldEcosystem(current).document : null,
      slugHeldBy: await ecosystemHolding(tx, 'slug', document.ecosystem.slug, id),
      codeHeldBy: await ecosystemHolding(tx, 'channelCode', document.channel.code, id),
      numbersReserved: current ? await numbersReserved(tx, id) : false,
      memberCommitments: current ? await commitments(tx, id) : [],
    });
    if (refusals.length > 0) return { ok: false, refusals };
    if (current && JSON.stringify(current.document) === JSON.stringify(document)) {
      return { ok: true, held: heldEcosystem(current), created: false };
    }
    const row = await putEcosystem(
      tx,
      {
        id,
        revision: (storedRevision ?? 0) + 1,
        slug: document.ecosystem.slug,
        channelCode: document.channel.code,
        stewardOrgId: document.ecosystem.steward,
      },
      document,
      userId,
    );
    return { ok: true, held: heldEcosystem(row), created: current === null };
  });
}

export async function createEcosystem(input: {
  userId: string;
  raw: unknown;
}): Promise<EcosystemOutcome> {
  const id = randomUUID();
  const parsed = parseEcosystem(input.raw, id, true);
  if (!parsed.ok) return parsed;
  await assertStewardAdmin(parsed.value.ecosystem.steward, input.userId);
  return store({ id, document: parsed.value, baseRevision: null, userId: input.userId });
}

export async function writeEcosystem(input: {
  id: string;
  userId: string;
  baseRevision: number | null;
  raw: unknown;
}): Promise<EcosystemOutcome> {
  const { id, userId, baseRevision, raw } = input;
  const current = await loadEcosystem(id);
  await assertStewardAdmin(current.stewardOrgId, userId);
  if (current.revision !== baseRevision) {
    return { ok: false, refusals: [staleBase(baseRevision, current.revision)] };
  }
  const parsed = parseEcosystem(raw, id, false);
  if (!parsed.ok) return parsed;
  if (parsed.value.ecosystem.steward !== current.stewardOrgId) {
    await assertStewardAdmin(parsed.value.ecosystem.steward, userId);
  }
  return store({ id, document: parsed.value, baseRevision, userId });
}
