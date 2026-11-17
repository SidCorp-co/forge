// A change core makes to one binding's stored config on its own, never a person's document write
// (ISS-1271: a project's thread of the shared operations room, opened on first need and recorded on
// that room's binding). It goes through the binding store's compare-and-set at the revision it read,
// as a document write does, so a concurrent write is never lost: where another write took the
// revision first, the config is read again and amended again over what that write left.

import { bindEffects } from './bind-effects.js';
import { drizzleBindingStore } from './binding-store.js';
import { isRecord } from './documents.js';

/** How many times a write another write overtook is read and amended again before it gives up. */
const ATTEMPTS = 5;

/**
 * Amend binding `bindingId`'s config with `amend`, which returns the whole new config, or null where
 * nothing is to change (what it would write is already there). True once written or already there;
 * throws where the binding is gone or every attempt was overtaken.
 */
export async function amendBindingConfig(
  bindingId: string,
  amend: (config: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current = await drizzleBindingStore.readBinding(bindingId);
    if (!current) throw new Error(`project-config: binding ${bindingId} is gone`);
    const config = amend(isRecord(current.config) ? current.config : {});
    if (!config) return true;
    const result = await drizzleBindingStore.casBinding({
      id: current.id,
      projectId: current.projectId,
      connectionId: current.connectionId,
      provider: current.provider,
      role: current.role,
      config,
      label: current.label,
      agentAccess: current.agentAccess,
      active: current.active,
      instructions: current.instructions,
      baseRevision: current.revision,
      integrationSecret: () => {
        throw new Error('project-config: an amend never creates a binding');
      },
    });
    if (result.ok) {
      await bindEffects.afterWrite({
        bindingId,
        projectId: current.projectId,
        connectionId: current.connectionId,
        provider: current.provider,
        role: current.role,
        config,
        created: false,
      });
      return true;
    }
    if (result.reason !== 'stale') {
      throw new Error(`project-config: binding ${bindingId} amend was not taken: ${result.reason}`);
    }
  }
  throw new Error(
    `project-config: binding ${bindingId} amend was overtaken ${ATTEMPTS} times by other writes`,
  );
}
