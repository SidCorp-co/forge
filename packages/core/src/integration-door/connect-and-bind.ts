/**
 * One call adds a connection and binds it into every project it serves (FB-128).
 *
 * The person on the Integrations page and an agent on the REST door send the same body: the
 * connection, and `bindings[]` naming each project and its binding-v1 target. Each item becomes
 * that project's binding-v1 document and meets every check `PUT /api/projects/:id/bindings/:id`
 * runs; one refusal writes nothing, the connection included, and names the project and target it
 * is about. A binding is still written only as its document: this assembles the documents, it is
 * not a second binding door.
 */

import { SCHEMA_BASE } from '@forge/contracts/project-config';
import type { TxOnly } from '../db/client.js';
import {
  type BindingItem,
  createConnection,
  type IntegrationConnectionRow,
} from '../integrations/index.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import {
  type ApiRefusal,
  type BindingsItem,
  type SwitchedOffSlot,
  slotFor,
  writeBindings,
} from '../project-config/index.js';
import { projectOrgHead } from '../projects/index.js';

/** A target in a refusal: its provider and fields, short enough to read in one line. */
function describeTarget(target: Record<string, unknown>): string {
  const fields = Object.entries(target)
    .filter(([key, value]) => key !== 'provider' && ['string', 'number'].includes(typeof value))
    .map(([key, value]) => `${key}=${String(value)}`);
  const text = [String(target.provider ?? 'no provider'), ...fields].join(' ');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

type BoundOutcome =
  | {
      ok: true;
      bindings: Array<{
        projectId: string;
        bindingId: string;
        revision: number;
        created: boolean;
        /** The switched-off binding this write took over in the project's slot, or null: said, never silent. */
        rewroteSwitchedOff: SwitchedOffSlot | null;
        effects: Record<string, unknown>;
      }>;
    }
  | { ok: false; refusals: ApiRefusal[] };

/**
 * Bind `connection` into each item's project, as one write. `store` is set when the connection is
 * being created by the same call: it is written in the bindings' transaction, and checked
 * against before it exists.
 */
export async function bindConnectionInto(args: {
  userId: string;
  connection: IntegrationConnectionRow;
  items: readonly BindingItem[];
  store?: boolean;
}): Promise<BoundOutcome> {
  const { userId, connection, items } = args;
  const actor = actorFor(userId);
  const heads = await Promise.all(items.map((item) => projectOrgHead(item.projectId)));
  const administered = await Promise.all(
    items.map((item) => can(actor, 'project.admin', projectResource(item.projectId))),
  );
  const named = (index: number) => {
    const item = items[index] as BindingItem;
    const head = heads[index];
    const project =
      head && administered[index] ? `project ${head.slug}` : `project ${item.projectId}`;
    return `${project} (${describeTarget(item.target)})`;
  };

  const refused: ApiRefusal[] = [];
  for (const index of items.keys()) {
    if (!heads[index] || !administered[index]) {
      refused.push({
        code: 'PROJECT_NOT_ADMINISTERED',
        path: `/bindings/${index}/projectId`,
        detail: `${named(index)}: you do not administer this project, and a connection is bound only into a project you administer.`,
      });
    }
  }
  if (refused.length > 0) return { ok: false, refusals: refused };

  const slots = await Promise.all(
    items.map((item) =>
      slotFor(
        item.projectId,
        String(item.target.provider ?? connection.provider),
        typeof item.target.label === 'string' ? item.target.label : '',
        item.role,
      ),
    ),
  );
  const documents: BindingsItem[] = items.map((item, index) => {
    const slot = slots[index] as (typeof slots)[number];
    return {
      projectId: item.projectId,
      bindingId: slot.bindingId,
      baseRevision: slot.baseRevision,
      raw: {
        $schema: `${SCHEMA_BASE}/binding-v1.json`,
        version: 1,
        id: slot.bindingId,
        role: item.role,
        connection: connection.id,
        ...(item.agentAccess ? { agentAccess: item.agentAccess } : {}),
        active: true,
        ...(item.instructions ? { instructions: item.instructions } : {}),
        target: item.target,
      },
    };
  });

  const outcome = await writeBindings({
    userId,
    items: documents,
    ...(args.store
      ? {
          pending: connection,
          storePending: async (tx: TxOnly) => {
            await createConnection(connection, tx);
          },
        }
      : {}),
  });
  if (!outcome.ok) {
    return {
      ok: false,
      refusals: outcome.refusals.map(({ index, ...r }) => ({
        ...r,
        path: `/bindings/${index}${r.path === '' ? '' : r.path}`,
        detail: `${named(index)}: ${r.detail}`,
      })),
    };
  }
  return {
    ok: true,
    bindings: outcome.held.map((h, i) => ({
      projectId: h.projectId,
      bindingId: (documents[i] as BindingsItem).bindingId,
      revision: h.revision,
      created: h.created,
      rewroteSwitchedOff: (slots[i] as (typeof slots)[number]).rewrites,
      effects: h.effects,
    })),
  };
}
