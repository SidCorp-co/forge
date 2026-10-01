import type { AgentAccess, BindingRole } from '../../src/db/release-axes.js';

export interface SeedBindingInput {
  connectionId: string;
  projectId: string;
  provider: string;
  role: BindingRole;
  config?: Record<string, unknown>;
  integrationSecret?: string | null;
  label?: string;
  agentAccess?: AgentAccess;
}

export async function seedBinding(input: SeedBindingInput) {
  const { db } = await import('../../src/db/client.js');
  const { integrationBindings } = await import('../../src/db/schema.js');
  const [row] = await db
    .insert(integrationBindings)
    .values({
      connectionId: input.connectionId,
      projectId: input.projectId,
      provider: input.provider,
      role: input.role,
      config: input.config ?? {},
      integrationSecret: input.integrationSecret ?? null,
      label: input.label ?? '',
      active: true,
      agentAccess: input.agentAccess ?? 'none',
    })
    .returning();
  if (!row) throw new Error('seedBinding: insert returned no row');
  return row;
}
