// binding.write from the room (ISS-1455): which binding the owner's act writes, or why it names none.
// The write itself is the binding door's, with every check it makes; this only resolves `item`.

import { readBinding, slotFor, uuid } from '../project-config/index.js';
import { no } from './outcome.js';
import type { OpsOutcome } from './ops-types.js';

/** `item` that makes a project's binding instead of naming one it holds. */
export const NEW_BINDING = 'new';

const HOW =
  `item is the id of a binding this project holds, read from its bindings, with the revision you read as baseRevision; ` +
  `a binding it does not hold yet is made with item "${NEW_BINDING}", baseRevision null and the whole binding-v1 document ` +
  `(role, connection, target with its provider; the id is Forge's to choose, leave it out). Nothing was done`;

export type BindingWrite = { bindingId: string; baseRevision: number | null; raw: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The binding id, revision and document the door is to write, or the refusal naming what `item` was. */
export async function bindingWriteOf(
  projectId: string,
  item: string,
  baseRevision: number | null,
  document: unknown,
): Promise<OpsOutcome<BindingWrite>> {
  if (item === NEW_BINDING) {
    if (baseRevision !== null) {
      return no(
        'SUPPORT_FORGE_ACT_SHAPE',
        '/baseRevision',
        `item "${NEW_BINDING}" makes a binding, which has no revision to be based on: send baseRevision null, or the id of the binding you mean to change as item. Nothing was done`,
      );
    }
    const doc = isRecord(document) ? document : {};
    const target = isRecord(doc.target) ? doc.target : {};
    const slot = await slotFor(
      projectId,
      typeof target.provider === 'string' ? target.provider : '',
      typeof target.label === 'string' ? target.label : '',
      typeof doc.role === 'string' ? doc.role : '',
    );
    // a switched-off service binding of the same provider and label is the slot the door writes over
    return {
      ok: true,
      value: {
        bindingId: slot.bindingId,
        baseRevision: slot.baseRevision,
        raw: isRecord(document) ? { ...document, id: slot.bindingId } : document,
      },
    };
  }
  if (!uuid().safeParse(item).success || !(await readBinding(projectId, item))) {
    return no(
      'SUPPORT_FORGE_ACT_SHAPE',
      '/item',
      `"${item}" is the id of no binding of this project. ${HOW}`,
    );
  }
  return { ok: true, value: { bindingId: item, baseRevision, raw: document } };
}

