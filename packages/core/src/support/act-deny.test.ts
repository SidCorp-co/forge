import { beforeEach, describe, expect, it, vi } from 'vitest';

const supportApisOf = vi.fn();
vi.mock('../integrations/support-api/index.js', () => ({ supportApisOf }));
const readProjectDocument = vi.fn(async (): Promise<unknown> => null);
vi.mock('../project-config/index.js', () => ({ readProjectDocument }));
vi.mock('./store.js', () => ({ insertAction: vi.fn(), threadConversation: vi.fn() }));
const raiseTechnical = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('./technical-channel.js', () => ({ raiseTechnical }));

const { deniedActRefusal } = await import('./act-deny.js');
type Room = Parameters<typeof deniedActRefusal>[0];

const room = { id: 'room-1', projectId: 'project-1' } as Room;
// a name that says nothing of deletion: only its DELETE method puts it in data_deletion
const act = { action: 'propose_fix', thread: 't-1', tool: 'customer_cleanup' };
const deleteTool = {
  name: 'customer_cleanup',
  method: 'DELETE',
  path: '/customers/{id}',
  summary: 'Tidy a customer',
  binding: 'shop',
};

describe("deniedActRefusal: a support tool's class read from its binding", () => {
  beforeEach(() => {
    supportApisOf.mockReset();
  });

  it('refuses a DELETE tool as data_deletion where the binding is read', async () => {
    supportApisOf.mockResolvedValue({ bindings: [], tools: [deleteTool] });
    const out = await deniedActRefusal(room, act);
    expect(out?.ok).toBe(false);
    expect(out && !out.ok && out.refusals[0]?.code).toBe('SUPPORT_ACT_DENIED');
  });

  it('fails closed where the bindings cannot be read, never classifying by the name alone', async () => {
    supportApisOf.mockImplementation(async () => {
      throw new Error('support-api: binding b1 (shop) holds a fault');
    });
    await expect(deniedActRefusal(room, act)).rejects.toThrow('binding b1 (shop) holds a fault');
  });
});

describe('deniedActRefusal: a production deploy is named as people know it', () => {
  it("raises the deploy by its environment's name, never the binding's id", async () => {
    const binding = '6f1c2a9e-4b7d-4c1e-9a3f-2d8e7b6c5a41';
    readProjectDocument.mockResolvedValue({
      document: { environments: { live: { tier: 'production', deployment: { binding } } } },
    });
    const out = await deniedActRefusal(room, { action: 'deploy', thread: 't-1', target: binding });
    expect(out && !out.ok && out.refusals[0]?.code).toBe('SUPPORT_ACT_DENIED');
    const text = (raiseTechnical.mock.calls[0]?.[1] as { text: string }).text;
    expect(text).toContain('(deploy: deploy to live)');
    expect(text).not.toContain(binding);
  });
});
