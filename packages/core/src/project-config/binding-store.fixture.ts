import type { BindingStore, ConnectionFacts, StoredBinding } from './binding-store.js';
import { mem, PROJECT } from './memory-store.fixture.js';

export const ORG = '55555555-5555-4555-8555-555555555555';
export const COOLIFY_CONNECTION = '66666666-6666-4666-8666-666666666666';
export const SHOPIFY_CONNECTION = '77777777-7777-4777-8777-777777777777';

export const bindingMem = {
  rows: new Map<string, StoredBinding>(),
  connections: new Map<string, ConnectionFacts>(),
  orgAdmins: new Set<string>(),
  secrets: new Map<string, string>(),
};

function syncActive(row: StoredBinding) {
  mem.bindings = mem.bindings.filter((b) => b.id !== row.id);
  if (row.active) {
    mem.bindings.push({
      id: row.id,
      role: row.role,
      provider: row.provider,
      label: row.label,
    });
  }
}

export function seedBindingRow(
  seed: Omit<StoredBinding, 'instructions'> & { instructions?: string | null },
) {
  const row: StoredBinding = { ...seed, instructions: seed.instructions ?? null };
  bindingMem.rows.set(row.id, row);
  syncActive(row);
}

export function resetBindingMem() {
  bindingMem.rows.clear();
  bindingMem.connections.clear();
  bindingMem.orgAdmins.clear();
  bindingMem.secrets.clear();
  mem.bindings = [];
}

export const memoryBindingStore: BindingStore = {
  async readBinding(id) {
    return bindingMem.rows.get(id) ?? null;
  },
  async listProjectBindings(projectId) {
    return [...bindingMem.rows.values()].filter((r) => r.projectId === projectId);
  },
  async readConnection(id) {
    return bindingMem.connections.get(id) ?? null;
  },
  async projectOrgId(projectId) {
    return projectId === PROJECT ? ORG : null;
  },
  async isOrgAdmin(_orgId, userId) {
    return bindingMem.orgAdmins.has(userId);
  },
  async casBinding({ baseRevision, integrationSecret, ...write }) {
    const current = bindingMem.rows.get(write.id);
    if (current && current.projectId !== write.projectId) return { ok: false, reason: 'foreign' };
    const storedRevision = current?.revision ?? null;
    if (storedRevision !== baseRevision) return { ok: false, reason: 'stale', storedRevision };
    if (!current) bindingMem.secrets.set(write.id, await integrationSecret());
    const stored: StoredBinding = { ...write, revision: (current?.revision ?? 0) + 1 };
    seedBindingRow(stored);
    return { ok: true, stored, created: !current, changed: true };
  },
};
