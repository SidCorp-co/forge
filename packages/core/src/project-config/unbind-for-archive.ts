// Switching off a project's chat groups and deploy bindings when it is archived (ISS-1449).

import { drizzleBindingStore as store } from './binding-store.js';
import { removeBinding } from './bindings.js';
import type { ApiRefusal } from './documents.js';

/** What an archive switched off: the binding, its provider and role. */
export interface UnboundBinding {
  id: string;
  provider: string;
  role: string;
}

/**
 * Switch off every live binding the caller names a project's archive must let go of (ISS-1449):
 * the caller owns which bindings those are (the room's chat group and each deploy binding). Only the binding row is switched off, as
 * {@link removeBinding} does: the adapter is never called, so no deploy, teardown or webhook reaches
 * a site, and the repository (the `source` role) is not read. A binding that cannot be switched off
 * is refused by its own refusal, naming it; the ones switched off before it stay off.
 */
export async function unbindForArchive(
  projectId: string,
  letGo: (binding: { provider: string; role: string }) => boolean,
): Promise<{ ok: true; unbound: UnboundBinding[] } | { ok: false; refusals: ApiRefusal[] }> {
  const unbound: UnboundBinding[] = [];
  for (const row of await store.listProjectBindings(projectId)) {
    if (!row.active || !letGo(row)) continue;
    const out = await removeBinding({
      projectId,
      bindingId: row.id,
      baseRevision: row.revision,
      archiving: true,
    });
    if (!out.ok) {
      return {
        ok: false,
        refusals:
          'refusals' in out
            ? out.refusals
            : [
                {
                  code: 'BINDING_NOT_FOUND',
                  path: `/bindings/${row.id}`,
                  detail: `binding ${row.id} (${row.provider}) vanished while it was switched off`,
                },
              ],
      };
    }
    unbound.push({ id: row.id, provider: row.provider, role: row.role });
  }
  return { ok: true, unbound };
}
