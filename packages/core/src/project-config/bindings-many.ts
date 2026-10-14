import { randomUUID } from 'node:crypto';
import type { TxOnly } from '../db/client.js';
import type { IntegrationConnectionRow } from '../integrations/index.js';
import { drizzleBindingStore } from './binding-store.js';
import {
  type BindingPlan,
  casRefusal,
  casWriteOf,
  effectsOf,
  type PlannedBinding,
  planBinding,
} from './bindings.js';
import type { ApiRefusal } from './documents.js';
import type { BindingDocument } from './schema.js';

const store = drizzleBindingStore;

/** One binding of a {@link writeBindings} call: a project, and the binding-v1 document for it. */
export interface BindingsItem {
  projectId: string;
  bindingId: string;
  baseRevision: number | null;
  raw: unknown;
}

type BindingsOutcome =
  | {
      ok: true;
      held: Array<{
        projectId: string;
        revision: number;
        document: BindingDocument;
        created: boolean;
        effects: Record<string, unknown>;
      }>;
    }
  | { ok: false; refusals: Array<ApiRefusal & { index: number }> };

/**
 * Several binding documents written as one: every check runs for every item, and a single refusal
 * writes none of them, `pending` included. `pending` is the connection the same call creates; it
 * is stored in the same transaction as the bindings, so a refused bind never leaves a connection
 * behind (FB-128). Each refusal carries the index of the item it is about.
 */
export async function writeBindings(input: {
  userId: string;
  items: readonly BindingsItem[];
  pending?: IntegrationConnectionRow | null;
  storePending?: (tx: TxOnly) => Promise<void>;
}): Promise<BindingsOutcome> {
  const pending = input.pending ?? null;
  const planned = await Promise.all(
    input.items.map((item) => planBinding({ ...item, userId: input.userId, pending })),
  );
  const refusals = planned.flatMap((p, index) =>
    p.ok ? [] : p.refusals.map((r) => ({ ...r, index })),
  );
  if (refusals.length > 0) return { ok: false, refusals };
  const plans = planned.map((p) => (p as Extract<BindingPlan, { ok: true }>).plan);

  const committed = await store.casBindings(
    plans.map((plan) => casWriteOf(plan, pending)),
    input.storePending,
  );
  if (!committed.ok) {
    const plan = plans[committed.index] as PlannedBinding;
    return {
      ok: false,
      refusals: [
        {
          ...casRefusal(committed.result, {
            baseRevision: plan.baseRevision,
            bindingId: plan.bindingId,
            doc: plan.doc,
            encoded: plan.encoded,
          }),
          index: committed.index,
        },
      ],
    };
  }
  const held = [];
  for (const [i, plan] of plans.entries()) {
    const result = committed.results[i] as (typeof committed.results)[number];
    held.push({
      projectId: plan.projectId,
      revision: result.stored.revision,
      document: { ...plan.doc, agentAccess: plan.agentAccess, active: plan.active },
      created: result.created,
      effects: await effectsOf(plan, result),
    });
  }
  return { ok: true, held };
}

/**
 * The binding a new document for (project, provider, label) writes: the switched-off service
 * binding already holding that slot, at its revision, or a new id. A switched-off row keeps its
 * slot (`integration_bindings_service_uq` has no `active` predicate), so binding again writes it.
 */
export async function slotFor(
  projectId: string,
  provider: string,
  label: string,
  role: string,
): Promise<{ bindingId: string; baseRevision: number | null }> {
  if (role === 'service') {
    const held = (await store.listProjectBindings(projectId)).find(
      (b) => b.role === 'service' && b.provider === provider && b.label === label && !b.active,
    );
    if (held) return { bindingId: held.id, baseRevision: held.revision };
  }
  return { bindingId: randomUUID(), baseRevision: null };
}
