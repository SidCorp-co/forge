import { SCHEDULE_KINDS } from '@forge/contracts/schedules';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const createSchedule = vi.fn(async (input: { kind?: string }) => ({ id: 's-1', ...input }));
vi.mock('../../schedules/service.js', () => ({
  createSchedule,
  deleteSchedule: vi.fn(),
  getSchedule: vi.fn(),
  listSchedulesForMcp: vi.fn(),
  readScheduleProjectId: vi.fn(),
  runScheduleNow: vi.fn(),
  updateSchedule: vi.fn(),
}));
vi.mock('./lib.js', async (orig) => ({
  ...(await orig<typeof import('./lib.js')>()),
  assertPrincipalIsAdmin: vi.fn(async () => undefined),
}));

const { forgeSchedulesTool } = await import('./forge-schedules.js');
const { scheduleKinds } = await import('../../db/schema.js');

const tool = forgeSchedulesTool({ principal: { userId: 'u1' } } as never);
const PROJECT = '85c4395c-015d-4359-818c-daf1f300d5c0';
const BODY: Record<string, Record<string, string>> = {
  prompt: { prompt: 'triage the inbox' },
  script: { script: 'ctx.log(1)' },
  release_batch: {},
  sentry_pull: {},
};

describe('forge_schedules accepts every kind the server stores', () => {
  it('its kind enum is the stored kinds, from contracts', () => {
    const schema = tool.inputSchema as { properties: { kind: { enum: string[] } } };
    expect(schema.properties.kind.enum).toEqual([...SCHEDULE_KINDS]);
    expect([...scheduleKinds]).toEqual([...SCHEDULE_KINDS]);
  });

  for (const kind of SCHEDULE_KINDS) {
    it(`creates a ${kind} schedule`, async () => {
      const out = (await tool.handler({
        action: 'create',
        projectId: PROJECT,
        name: `every-${kind}`,
        cron: '0 3 * * *',
        kind,
        ...BODY[kind],
      })) as { schedule: { kind: string } };
      expect(out.schedule.kind).toBe(kind);
      expect(createSchedule).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind, projectId: PROJECT }),
        'u1',
      );
    });
  }

  it('refuses a kind the server does not store', async () => {
    await expect(
      tool.handler({
        action: 'create',
        projectId: PROJECT,
        name: 'x',
        cron: '0 3 * * *',
        kind: 'pm',
      }),
    ).rejects.toThrow();
  });
});
