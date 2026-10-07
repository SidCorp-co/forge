import { beforeEach, describe, expect, it, vi } from 'vitest';

let config: { baseUrl: string; targets: { id: string; label: string; resourceUuid: string }[] };

vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../project-config/index.js', async (orig) => ({
  ...(await orig<typeof import('../project-config/index.js')>()),
  readDeployMap: async () => ({ productionBinding: null, environments: new Map() }),
}));
vi.mock('../integrations/index.js', async (orig) => ({
  ...(await orig<typeof import('../integrations/index.js')>()),
  listActiveDeployBindingsForProvider: async () => [
    {
      binding: { id: 'b1', provider: 'coolify', config },
      connection: { lastHealthStatus: 'ok', breakerOpenedAt: null, config: {} },
    },
  ],
  effectiveConfig: () => config,
  findLastOutboundForTarget: async () => null,
}));

import { coolifyDeliveryStatus } from './coolify-commands.js';

describe('coolifyDeliveryStatus', () => {
  beforeEach(() => {
    config = {
      baseUrl: 'https://c.example',
      targets: [{ id: 't1', label: 'App', resourceUuid: 'r1' }],
    };
  });

  it('reads one row per target', async () => {
    const { deliveries } = await coolifyDeliveryStatus({ projectId: 'p' });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      integrationId: 'b1',
      targetId: 't1',
      targetLabel: 'App',
    });
  });

  it('refuses a binding with no targets by name instead of inventing an integration-level row', async () => {
    config.targets = [];
    await expect(coolifyDeliveryStatus({ projectId: 'p' })).rejects.toMatchObject({
      name: 'RefusalError',
      refusals: [expect.objectContaining({ code: 'COOLIFY_TARGET_UNRESOLVED' })],
    });
  });
});
